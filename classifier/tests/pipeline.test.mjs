import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Pipeline} from '../pipeline.js';
import {encodeWav} from '../audio.js';
import {BANKS, bankSummary, FAMILIES} from '../taxonomy.js';
import {ReviewLibrary} from '../review/library.js';

test('bank counts deduplicate placements, respect custom rules and expose empty/unassigned banks', () => {
    const row = (id, tags, state = 'ready') => ({id, tags, state});
    const rows = [row('kick', ['drums', 'kick']), row('kick', ['drums', 'kick']),
        row('perc', ['drums', 'percussion']), row('plain', ['synth']), row('pad', ['synth', 'pad']),
        row('voice', ['vocal']), row('note', ['vocal', 'vocal-note']), row('recorded', ['synth', 'bass', 'recorded']),
        row('unknown', ['unclassified']), row('failed', ['synth', 'bass'], 'failed')];
    const summary = bankSummary(BANKS, rows, new Map([['kick', 3]]));
    assert.equal(summary.uniqueSamples, 8);
    assert.equal(summary.unassigned, 1);
    assert.deepEqual(summary.banks.map(group => group.map(bank => bank.sounds)), [[1, 3, 1, 0], [0, 0, 1, 0], [0, 2, 1, 1]]);
    assert.equal(summary.banks[0][1].kits, 1);
    const custom = structuredClone(BANKS);
    custom.banks[2][0] = {label: 'Custom', kind: 'samples', tagsAll: ['unclassified']};
    assert.equal(bankSummary(custom, rows).banks[2][0].sounds, 1);
    assert.equal(bankSummary(custom, rows).unassigned, 0);
});

async function fixture(emit = () => {}) {
    // Asset metadata is local. No models or source audio are downloaded by these tests.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async url => ({ok: true, json: async () => JSON.parse(await readFile(url, 'utf8'))});
    let pipeline;
    try {
        pipeline = new Pipeline(emit, () => { throw new Error('Unexpected compressed decode'); });
        await Promise.all([pipeline.inference.assetsPromise, pipeline.inference.prototypesPromise, pipeline.inference.filtersPromise]);
    } finally { globalThis.fetch = originalFetch; }
    const scores = Object.fromEntries([...Object.values(FAMILIES).flat(), 'silence'].map(tag => [tag, .01]));
    pipeline.inference.analyse = async (channels, rate) => {
        const role = version => ({version: 1, analysisVersion: version, samples: channels[0].length, rate,
            root: 60, hasRoot:true, confidence: 1, transients: [], beats: [], downbeats: [], gateVersion: 1, gateStarts: [], gateStrengths: []});
        return {version: 1, channels: channels.length, pitch: role(5), loop: role(8),
            vocal: {...role(2), vocalStarts: [0], vocalDefaults: [0], gateStarts: [0], gateStrengths: [1]}};
    };
    pipeline.inference.audio = async (channels, rate) => ({version: 1, frontend: (await import('../inference.js')).FRONTEND,
        modelSha256: (await pipeline.inference.assetsPromise).models.audio.sha256, rate,
        samples: channels[0].length, channels: channels.length, peak: .2, vectors: [[1, ...Array(511).fill(0)]]});
    pipeline.inference.scores = async () => scores;
    const files = ['kick.wav', 'pad.wav'].map((path, index) => ({path,
        file: new Blob([encodeWav([Float32Array.from({length:800+index},(_,i)=>.2*Math.sin(i*.31))], 8000)])}));
    const options = {hints: true, split: false, beats: false, kits: false, force: false};
    return {pipeline, files, options};
}

test('completed sources publish once, cached reruns and corrections retain accurate bank summaries', async () => {
    const events = [], f = await fixture(event => events.push(event));
    await f.pipeline.run(f);
    const writes = events.filter(event => event.type === 'output' && event.path === '.egc1/library.json');
    assert.equal(writes.length, 4, 'initial catalogue + one per source + final catalogue');
    assert.equal(f.pipeline.report.bankSummary.banks[0][0].sounds, 1);
    assert.equal(f.pipeline.report.bankSummary.banks[2][2].sounds, 1);
    assert.equal(f.pipeline.report.newEmbeddings, 2);
    assert(f.pipeline.report.timings.elapsedMs > 0);
    assert(f.pipeline.report.timings.metadataWrites > 0);
    assert(f.pipeline.report.timings.metadataWriteMs >= 0);
    const saved = [...f.pipeline.folder.outputs].map(([path, file]) => ({path, file}));
    await f.pipeline.run({...f, files: [...f.files, ...saved]});
    assert.equal(f.pipeline.report.reusedAnalysis, 2);
    assert.equal(f.pipeline.report.reusedEmbeddings, 2);
    assert.equal(f.pipeline.report.newEmbeddings, 0);
    const pad = [...f.pipeline.rows.values()].find(row => row.path === 'pad.wav');
    await f.pipeline.correct(pad.id, ['synth', 'bass']);
    assert.equal(f.pipeline.report.bankSummary.banks[2][0].sounds, 0,'category edits require explicit approval');
    assert.equal(f.pipeline.report.bankSummary.banks[2][2].sounds, 0);
    assert.equal(events.at(-1).type, 'corrected');
    assert.deepEqual(events.at(-1).summary, f.pipeline.report.bankSummary);
});

test('pause after a result saves the completed source and leaves the remainder resumable', async () => {
    let pipeline;
    const f = await fixture(event => { if (event.type === 'result') { pipeline.pause = true; } });
    pipeline = f.pipeline;
    await pipeline.run(f);
    const saved = await pipeline.folder.json('.egc1/library.json');
    assert.equal(saved.state, 'processing');
    assert.equal(saved.classification.done, 1);
    assert.equal(saved.entries.length, 1);
    assert.equal(pipeline.report.state, 'paused');
});

test('pause between separated regions publishes the partial source before stopping', async () => {
    let pipeline;
    const f = await fixture(event => { if (event.type === 'result') { pipeline.pause = true; } });
    pipeline = f.pipeline;
    const audio = new Float32Array(16000);
    for (const start of [1000,9000]) { for (let i=0;i<1000;i++) { audio[start+i]=.2*Math.sin(i*.31); } }
    await pipeline.run({...f, files: [{path: 'multi.wav', file: new Blob([encodeWav([audio], 8000)])}],
        options: {...f.options, split: true}});
    const saved = await pipeline.folder.json('.egc1/library.json');
    assert.equal(saved.state, 'processing');
    assert.equal(saved.classification.done, 0);
    const workspace = await pipeline.folder.json('.egc1/workspace.json');
    assert.equal(workspace.entries.length, 1);
    assert(workspace.entries[0].provenance);
    assert.equal(saved.entries.length,0,'uncertain categories remain outside the playable catalogue');
});

async function approve(f, path, bounds) {
    const values=new Map(),cache={get:async key=>values.get(key),set:async(key,value)=>values.set(key,value)};
    const library=await new ReviewLibrary(f.pipeline.folder,cache,()=>{},
        {analyse:async(channels,rate)=>({...await f.pipeline.inference.analyse(channels,rate),pipeline:f.pipeline.pipeline})}).initialise();
    const item=[...library.items.values()].find(item=>item.path===path);
    await library.save(item.id,{tags:['drums','kick'],quality:'reject',certainty:'clear',reasons:['attack'],notes:'corrected',boundaries:bounds});
    await library.admit(item.id,{reviewedAt:library.export().reviews[item.id].updatedAt,transients:[bounds.attackFrame]});
    return {library,item};
}

test('approved corrections and rejected candidates survive browser reprocessing',async()=>{
    const f=await fixture();await f.pipeline.run(f);
    const {library,item}=await approve(f,'kick.wav',{attackFrame:10,endFrame:700});
    const out=(await f.pipeline.folder.json('.egc1/library.json')).entries.find(row=>row.provenance.sourcePath==='kick.wav');
    const inputs=()=>[...f.files,...[...f.pipeline.folder.outputs].map(([path,file])=>({path,file}))];
    await f.pipeline.run({...f,files:inputs()});
    assert((await f.pipeline.folder.json('.egc1/library.json')).entries.some(row=>row.id===out.id));
    assert((await f.pipeline.folder.json('.egc1/workspace.json')).decisions[item.id].length);
    // Use the current folder snapshot, as a newly opened review tab would.
    const current=new ReviewLibrary(f.pipeline.folder,library.cache);
    await current.initialise();
    await current.admit(item.id,{reviewedAt:current.export().reviews[item.id].updatedAt},true);
    await f.pipeline.run({...f,files:inputs()});
    assert(!(await f.pipeline.folder.json('.egc1/library.json')).entries.some(row=>row.id===out.id));
});

test('a long continuous source goes to review and its approved short phrase survives reprocessing',async()=>{
    const f=await fixture();
    f.files=[{path:'long.wav',file:new Blob([encodeWav([Float32Array.from({length:61*8000},(_,i)=>.2*Math.sin(i*.31))],8000)])}];
    await f.pipeline.run(f);
    assert.equal((await f.pipeline.folder.json('.egc1/library.json')).entries.length,0);
    assert.equal((await f.pipeline.folder.json('.egc1/workspace.json')).entries[0].state,'needs-review');
    await approve(f,'long.wav',{attackFrame:800,endFrame:8800});
    const inputs=[...f.files,...[...f.pipeline.folder.outputs].map(([path,file])=>({path,file}))];
    await f.pipeline.run({...f,files:inputs});
    const rows=(await f.pipeline.folder.json('.egc1/library.json')).entries;
    assert.equal(rows.length,1);assert.equal(rows[0].samples,8000);
});

test('forced reanalysis cannot overwrite a manual root when output bytes match the original audio',async()=>{
    const f=await fixture();await f.pipeline.run(f);
    const values=new Map(),cache={get:async key=>values.get(key),set:async(key,value)=>values.set(key,value)};
    const library=await new ReviewLibrary(f.pipeline.folder,cache,()=>{},
        {analyse:async(channels,rate)=>({...await f.pipeline.inference.analyse(channels,rate),pipeline:f.pipeline.pipeline})}).initialise();
    const item=[...library.items.values()].find(item=>item.path==='kick.wav');
    await library.save(item.id,{tags:['synth','bass'],certainty:'clear',quality:'keep',reasons:['wrong-root'],notes:'correct root',boundaries:{attackFrame:0,endFrame:800}});
    await library.admit(item.id,{reviewedAt:library.export().reviews[item.id].updatedAt,transients:[0],root:43});
    const output=(await f.pipeline.folder.json('.egc1/library.json')).entries.find(row=>row.tags.includes('bass'));
    assert.equal(output.id,item.analysisId,'fixture exercises the same-content analysis collision');
    const files=[...f.files,...[...f.pipeline.folder.outputs].map(([path,file])=>({path,file}))];
    await f.pipeline.run({...f,files,options:{...f.options,force:true}});
    assert.equal((await f.pipeline.folder.json(`.egc1/entries/${output.id}.json`)).pitch.root,43);
    assert.equal((await f.pipeline.folder.json(`.egc1/browser/raw-analysis/${output.id}.json`)).pitch.root,60);
});
