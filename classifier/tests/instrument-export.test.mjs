import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join, relative} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {Folder} from '../storage.js';
import {encodeWav, hashFile} from '../audio.js';
import {BANKS} from '../taxonomy.js';
import {planInstrumentExport, exportInstrumentLibrary, instrumentExportName} from '../instrument-export.js';

const blob = value => new Blob([JSON.stringify(value)]);
function analysis(id, samples, rate) {
    const role = version => ({version:1, analysisVersion:version, rate, samples, hasRoot:true, root:60, confidence:1,
        transients:[0], beats:[], downbeats:[], gateVersion:1, gateStarts:[0], gateStrengths:[1]});
    return {version:1, id, pipeline:'test', channels:1, pitch:role(5), loop:role(8), vocal:{...role(2), analysisRole:'vocal', vocalStarts:[0], vocalDefaults:[0]}};
}
async function fixture() {
    const rate = 8000, samples = 8000;
    const audio = new Blob([encodeWav([Float32Array.from({length:samples}, (_, i) => .4 * Math.sin(i * .19))], rate)]), id = await hashFile(audio);
    const cut = new Blob([encodeWav([new Float32Array(4000).fill(.1)], rate)]), cutId = await hashFile(cut);
    const path = `.egc1/regions/${id}/0-4000-playable.wav`;
    const row = {id:cutId, path, state:'ready', rate, samples:4000, channels:1, bytes:cut.size, tags:['loops','drum-loop'],
        provenance:{kind:'separated', sourceId:id, sourcePath:'Pack/Original.wav', sourceSamples:samples, start:0, end:4000, rate}};
    const kitPath = `.egc1/kits/${cutId}/kit.json`, hitPath = `.egc1/kits/${cutId}/hit.wav`;
    const hit = new Blob([encodeWav([new Float32Array(2000).fill(.2)], rate)]), hitId = await hashFile(hit);
    const kit = {version:1, sourceId:cutId, rate, hits:[{file:'hit.wav', start:0, end:2000, id:hitId}]};
    const manifest = {version:1, state:'complete', entries:[row]};
    const folder = new Folder(null, [
        {path:'.egc1/library.json', file:blob(manifest)}, {path:'.egc1/banks.json', file:blob(BANKS)},
        {path:'.egc1/workspace.json', file:blob({...manifest, entries:[row, {...row, id:'b'.repeat(64), state:'needs-review', path:'rejected.wav'}]})},
        {path:'Pack/Original.wav', file:audio}, {path, file:cut},
        {path:`.egc1/entries/${cutId}.json`, file:blob(analysis(cutId, 4000, rate))},
        {path:kitPath, file:blob(kit)}, {path:hitPath, file:hit},
        {path:'.egc1/browser/embeddings/cache.json', file:blob({not:'needed'})},
        {path:'.egc1/semantic/cache.json', file:blob({not:'needed'})},
        {path:'.egc1/imports/cache.json', file:blob({not:'needed'})},
        {path:'rejected.wav', file:new Blob(['must not export'])},
        {path:'.egc1/instrument-feedback.json', file:blob({version:1, revision:1, items:{}})},
    ]);
    return {folder, row, manifest, kit, kitPath, hitPath};
}

// Exercise actual files and atomic close/abort behaviour through the browser's
// directory-handle interface. No real sample library or USB stick is written.
class Directory {
    constructor(path, writes = [], fail = () => false) { this.path = path; this.writes = writes; this.fail = fail; }
    async getDirectoryHandle(name, {create = false} = {}) {
        const path = join(this.path, name);
        try {
            if (create) { await fs.mkdir(path, {recursive:true}); }
            if (!(await fs.stat(path)).isDirectory()) { throw Error('Not a directory'); }
        } catch (error) { if (error.code === 'ENOENT') { throw new DOMException('Missing', 'NotFoundError'); } throw error; }
        return new Directory(path, this.writes, this.fail);
    }
    async getFileHandle(name, {create = false} = {}) {
        const path = join(this.path, name), owner = this;
        if (!create) {
            try { await fs.stat(path); }
            catch (error) { if (error.code === 'ENOENT') { throw new DOMException('Missing', 'NotFoundError'); } throw error; }
        }
        return {
            async getFile() { return new File([await fs.readFile(path)], name); },
            async createWritable() {
                const chunks = [];
                return {
                    async write(data) { if (owner.fail(path)) { throw Error('disk full'); } chunks.push(data); },
                    async close() { await fs.writeFile(path, new Uint8Array(await new Blob(chunks).arrayBuffer())); owner.writes.push(path); },
                    async abort() { chunks.length = 0; },
                };
            },
        };
    }
    async *entries() { for (const item of await fs.readdir(this.path, {withFileTypes:true})) { yield [item.name, {kind:item.isDirectory() ? 'directory' : 'file'}]; } }
    async resolve(other) {
        const path = relative(this.path, other.path);
        return path === '' ? [] : path.startsWith('..') ? null : path.split('/');
    }
}
async function destination(t) {
    const path = await fs.mkdtemp(join(tmpdir(), 'egc-export-test-'));
    t.after(() => fs.rm(path, {recursive:true, force:true}));
    return new Directory(path);
}
const exported = parent => join(parent.path, instrumentExportName('Samples'));
const read = async (parent, path) => JSON.parse(await fs.readFile(join(exported(parent), path), 'utf8'));

test('exports only published dependencies, preserves source bytes and can resume with zero writes', async t => {
    const f = await fixture(), parent = await destination(t), source = new Map(f.folder.files);
    const plan = await planInstrumentExport([{folder:f.folder}]);
    assert.equal(plan.samples, 1); assert.equal(plan.hits, 1);
    assert(![...plan.files.keys()].some(path => /workspace|embeddings|semantic|imports|rejected/.test(path)));
    assert(plan.files.has('Pack/Original.wav')); assert(plan.files.has(f.row.path));
    assert(plan.files.has(`.egc1/entries/${f.row.id}.json`)); assert(plan.files.has(f.kitPath));
    const first = await exportInstrumentLibrary(plan, parent, 'Samples');
    assert.equal(first.copied, plan.files.size); assert.equal(first.skipped, 0);
    for (const [path, {file}] of plan.files) {
        assert.deepEqual(await fs.readFile(join(exported(parent), path)), Buffer.from(await file.arrayBuffer()));
    }
    parent.writes.length = 0;
    const second = await exportInstrumentLibrary(plan, parent, 'Samples');
    assert.equal(second.copied, 0); assert.equal(second.skipped, plan.files.size);
    assert.equal(parent.writes.length, 0);
    assert.equal(f.folder.outputs.size, 0); assert.deepEqual(f.folder.files, source);
});

test('same-size edits are copied, destination damage repaired, feedback and recordings retained', async t => {
    const f = await fixture(), parent = await destination(t);
    let plan = await planInstrumentExport([{folder:f.folder}]);
    await exportInstrumentLibrary(plan, parent, 'Samples');
    const analysisPath = `.egc1/entries/${f.row.id}.json`, edited = analysis(f.row.id, 4000, 8000); edited.pitch.root = 61;
    assert.equal(blob(edited).size, f.folder.files.get(analysisPath).size);
    f.folder.files.set(analysisPath, blob(edited));
    const feedback = join(exported(parent), '.egc1/instrument-feedback.json');
    await fs.writeFile(feedback, JSON.stringify({version:1, revision:9, items:{instrument:true}}));
    await fs.mkdir(join(exported(parent), 'Recordings'));
    await fs.writeFile(join(exported(parent), 'Recordings/live.wav'), 'instrument take');
    await fs.writeFile(join(exported(parent), f.row.path), Buffer.alloc(f.row.bytes));
    plan = await planInstrumentExport([{folder:f.folder}]);
    const result = await exportInstrumentLibrary(plan, parent, 'Samples');
    assert.equal(result.copied, 2);
    assert.equal((await read(parent, analysisPath)).pitch.root, 61);
    assert.equal((await read(parent, '.egc1/instrument-feedback.json')).revision, 9);
    assert.equal(await fs.readFile(join(exported(parent), 'Recordings/live.wav'), 'utf8'), 'instrument take');
});

test('withdraws excluded samples and kit hits on subsequent exports without deleting audio', async t => {
    const f = await fixture(), parent = await destination(t);
    await exportInstrumentLibrary(await planInstrumentExport([{folder:f.folder}]), parent, 'Samples');
    f.folder.files.delete(f.kitPath);
    await exportInstrumentLibrary(await planInstrumentExport([{folder:f.folder}]), parent, 'Samples');
    assert.equal((await read(parent, f.kitPath)).hits.length, 0);
    f.folder.files.set('.egc1/library.json', blob({...f.manifest, entries:[]}));
    const result = await exportInstrumentLibrary(await planInstrumentExport([{folder:f.folder}]), parent, 'Samples');
    assert.equal(result.copied, 1, 'withdrawing a sound is reported as a catalogue update');
    assert.equal((await read(parent, '.egc1/library.json')).entries.length, 0);
    assert.equal((await fs.stat(join(exported(parent), f.row.path))).size, f.row.bytes);
});

test('removed collection catalogues cannot keep old sounds playable', async t => {
    const f = await fixture(), parent = await destination(t);
    await exportInstrumentLibrary(await planInstrumentExport([{folder:f.folder, path:'A'}, {folder:f.folder, path:'B'}]), parent, 'Samples');
    await exportInstrumentLibrary(await planInstrumentExport([{folder:f.folder, path:'B'}]), parent, 'Samples');
    assert.equal((await read(parent, 'A/.egc1/library.json')).entries.length, 0);
    assert.equal((await read(parent, 'B/.egc1/library.json')).entries.length, 1);
});

test('combined sound counts count identical audio once across prepared siblings', async () => {
    const f = await fixture();
    const plan = await planInstrumentExport([{folder:f.folder, path:'A'}, {folder:f.folder, path:'B'}]);
    assert.equal(plan.samples, 1); assert.equal(plan.hits, 1);
    assert.equal(plan.catalogues.length, 2);
});

test('missing dependencies fail before any destination is written', async () => {
    const f = await fixture();
    f.folder.files.delete('Pack/Original.wav');
    await assert.rejects(planInstrumentExport([{folder:f.folder}]), /Missing original audio/);
});

test('paused runs can export their already-published sounds without resuming analysis', async () => {
    const f = await fixture();
    f.folder.files.set('.egc1/library.json', blob({...f.manifest, state:'processing'}));
    const plan = await planInstrumentExport([{folder:f.folder}]);
    assert.equal(plan.samples, 1);
    assert.equal(plan.publications.get('.egc1/library.json').state, 'complete');
});

test('changed source audio cannot be published and interrupted exports resume', async t => {
    const f = await fixture(), parent = await destination(t);
    f.folder.files.set('Pack/Original.wav', new Blob(['modified source']));
    const plan = await planInstrumentExport([{folder:f.folder}]);
    await assert.rejects(exportInstrumentLibrary(plan, parent, 'Samples'), /Source audio changed/);
    await assert.rejects(fs.stat(join(exported(parent), '.egc1/library.json')), {code:'ENOENT'});
    const fresh = await fixture();
    await exportInstrumentLibrary(await planInstrumentExport([{folder:fresh.folder}]), parent, 'Samples');
    assert.equal((await read(parent, '.egc1/library.json')).entries.length, 1);
});

test('disk-full writes preserve the previous file; retries complete the export', async t => {
    const f = await fixture(), parent = await destination(t);
    const plan = await planInstrumentExport([{folder:f.folder}]);
    parent.fail = path => path.endsWith('Original.wav');
    await assert.rejects(exportInstrumentLibrary(plan, parent, 'Samples'), /disk full/);
    await assert.rejects(fs.stat(join(exported(parent), '.egc1/library.json')), {code:'ENOENT'});
    parent.fail = () => false;
    await exportInstrumentLibrary(plan, parent, 'Samples');
    assert.equal((await read(parent, '.egc1/library.json')).entries.length, 1);
    const analysisPath = `.egc1/entries/${f.row.id}.json`, edited = analysis(f.row.id, 4000, 8000); edited.pitch.root = 61;
    f.folder.files.set(analysisPath, blob(edited));
    parent.fail = path => path.endsWith(`${f.row.id}.json`);
    const update = await planInstrumentExport([{folder:f.folder}]);
    await assert.rejects(exportInstrumentLibrary(update, parent, 'Samples'), /disk full/);
    assert.equal((await read(parent, analysisPath)).pitch.root, 60);
    parent.fail = () => false;
    await exportInstrumentLibrary(update, parent, 'Samples');
    assert.equal((await read(parent, analysisPath)).pitch.root, 61);
});

test('rejects source overlap and unowned destination folders', async t => {
    const f = await fixture(), parent = await destination(t);
    const plan = await planInstrumentExport([{folder:f.folder}]);
    await assert.rejects(exportInstrumentLibrary(plan, parent, 'Samples', {sourceRoots:[parent]}), /outside your source/);
    assert.equal((await fs.readdir(parent.path)).length, 0);
    await fs.mkdir(exported(parent)); await fs.writeFile(join(exported(parent), 'do-not-touch'), 'original');
    await assert.rejects(exportInstrumentLibrary(plan, parent, 'Samples'), /already contains files/);
    assert.equal(await fs.readFile(join(exported(parent), 'do-not-touch'), 'utf8'), 'original');
});

test('cancel preserves a completed export and legacy sources remain read-only', async t => {
    const f = await fixture(), parent = await destination(t);
    f.folder.files = new Map([...f.folder.files].map(([path, file]) => [path.replace(/^\.egc1\//, '.toysampler/'), file]));
    const plan = await planInstrumentExport([{folder:f.folder}]);
    await exportInstrumentLibrary(plan, parent, 'Samples');
    assert.equal(f.folder.outputs.size, 0);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(exportInstrumentLibrary(plan, parent, 'Samples', {signal:controller.signal}), {name:'AbortError'});
    assert.equal((await read(parent, '.egc1/library.json')).entries.length, 1);
});

test('rejects paths that collide on a case-insensitive destination', async () => {
    const f = await fixture();
    await assert.rejects(planInstrumentExport([{folder:f.folder, path:'Pack'}, {folder:f.folder, path:'pack'}]), /collide on a USB stick/);
});

test('stopping between files leaves no new catalogue and the next export resumes', async t => {
    const f = await fixture(), parent = await destination(t), controller = new AbortController();
    const plan = await planInstrumentExport([{folder:f.folder}]);
    await assert.rejects(exportInstrumentLibrary(plan, parent, 'Samples', {
        signal:controller.signal,
        progress:data => { if (data.path === 'Pack/Original.wav') { controller.abort(); } },
    }), {name:'AbortError'});
    await assert.rejects(fs.stat(join(exported(parent), '.egc1/library.json')), {code:'ENOENT'});
    const result = await exportInstrumentLibrary(plan, parent, 'Samples');
    assert(result.skipped > 0);
    assert.equal((await read(parent, '.egc1/library.json')).entries.length, 1);
});

test('native instrument reader accepts exported cuts and kit choices', {skip:!process.env.EGC_TOY_LIBRARY}, async t => {
    const f = await fixture(), parent = await destination(t);
    await exportInstrumentLibrary(await planInstrumentExport([{folder:f.folder}]), parent, 'Samples');
    const banks = execFileSync(process.env.EGC_TOY_LIBRARY, ['banks', exported(parent)], {encoding:'utf8'});
    assert.match(banks, /0:1 Extracted kits: 1/);
    assert.match(banks, /1:0 Drum loops: 1/);
});
