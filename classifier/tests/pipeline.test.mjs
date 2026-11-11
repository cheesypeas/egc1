import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Pipeline} from '../pipeline.js';
import {encodeWav} from '../audio.js';
import {BANKS, bankSummary, FAMILIES} from '../taxonomy.js';

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
            root: 60, confidence: 0, transients: [], beats: [], downbeats: [], gateVersion: 1, gateStarts: [], gateStrengths: []});
        return {version: 1, channels: channels.length, pitch: role(5), loop: role(8),
            vocal: {...role(2), vocalStarts: [0], vocalDefaults: [0], gateStarts: [0], gateStrengths: [1]}};
    };
    pipeline.inference.audio = async (channels, rate) => ({version: 1, frontend: (await import('../inference.js')).FRONTEND,
        modelSha256: (await pipeline.inference.assetsPromise).models.audio.sha256, rate,
        samples: channels[0].length, channels: channels.length, peak: .2, vectors: [[1, ...Array(511).fill(0)]]});
    pipeline.inference.scores = async () => scores;
    const files = ['kick.wav', 'pad.wav'].map((path, index) => ({path,
        file: new Blob([encodeWav([new Float32Array(800 + index).fill(.2)], 8000)])}));
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
    assert.equal(f.pipeline.report.bankSummary.banks[2][0].sounds, 1);
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
    audio.fill(.2, 1000, 2000); audio.fill(.2, 9000, 10000);
    await pipeline.run({...f, files: [{path: 'multi.wav', file: new Blob([encodeWav([audio], 8000)])}],
        options: {...f.options, split: true}});
    const saved = await pipeline.folder.json('.egc1/library.json');
    assert.equal(saved.state, 'processing');
    assert.equal(saved.classification.done, 0);
    assert.equal(saved.entries.length, 1);
    assert(saved.entries[0].provenance);
});
