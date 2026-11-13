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

test('Bass versus Lead assignment does not use the pitch estimate',async()=>{
    const {classifyScores}=await import('../taxonomy.js');
    const scores=Object.fromEntries([...Object.values(FAMILIES).flat(),'silence'].map(tag=>[tag,.01]));
    scores.lead=.4;scores.bass=.3;
    for(const root of [24,60,84]) {
        assert.deepEqual(classifyScores(scores,.5,{root,hasRoot:true,transients:[]}).tags,['synth','lead']);
    }
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

for(const rate of [48000,96000]) {
test(`older ${rate} Hz unconfirmed pitch caches refresh only pitch and retain beat maps and embeddings`,async()=>{
    const f=await fixture();
    f.files=[{path:'bass.wav',file:new Blob([encodeWav([Float32Array.from({length:rate},(_,i)=>.2*Math.sin(i*.01))],rate)])}];
    const analyse=f.pipeline.inference.analyse;
    f.pipeline.inference.analyse=async(...args)=>{
        const data=await analyse(...args);data.pitch.hasRoot=false;data.pitch.confidence=0;return data;
    };
    await f.pipeline.run(f);
    const inputs=[...f.files,...f.pipeline.folder.outputs].map(item=>Array.isArray(item) ? {path:item[0],file:item[1]} : item);
    const row=f.pipeline.rows.values().next().value;
    const before=await f.pipeline.folder.json(`.egc1/browser/raw-analysis/${row.id}.json`);
    let calls=0;
    const {PITCH_IMPLEMENTATION}=await import('../inference.js');
    f.pipeline.inference.pitch=async()=>{
        calls++;
        const pitch={...before.pitch,analysisImplementation:PITCH_IMPLEMENTATION,hasRoot:true,root:24,confidence:1};
        return {pitch,acousticPitch:{...pitch}};
    };
    f.pipeline.inference.analyse=()=>{throw Error('Full DSP/beat inference must not repeat');};
    f.pipeline.inference.audio=()=>{throw Error('Audio embedding inference must not repeat');};
    await f.pipeline.run({...f,files:inputs});
    const after=await f.pipeline.folder.json(`.egc1/browser/raw-analysis/${row.id}.json`);
    assert.equal(calls,1);assert.equal(after.pitch.root,24);
    assert.deepEqual(after.loop,before.loop);assert.deepEqual(after.vocal,before.vocal);
    assert.equal(f.pipeline.report.reusedEmbeddings,1);
    const updated=[...f.files,...f.pipeline.folder.outputs].map(item=>Array.isArray(item) ? {path:item[0],file:item[1]} : item);
    await f.pipeline.run({...f,files:updated});
    assert.equal(calls,1,'compatible updated pitch must not run again');
});
}

test('nested drum hints replace contaminated cached categories without rerunning models',async()=>{
    const events=[],f=await fixture(event=>events.push(event));
    f.files=f.files.slice(0,1).map(item=>({...item,path:'Bass Boutique/HC1_Sounds_And_Fx/HC1_Drum_Hits/HC1_Kicks/HC1_Kick_12.wav'}));
    const scores=Object.fromEntries([...Object.values(FAMILIES).flat(),'silence'].map(tag=>[tag,.01]));
    scores.kick=.4;scores.snare=.39;f.pipeline.inference.scores=async()=>scores;
    await f.pipeline.run(f);
    const workspace=await f.pipeline.folder.json('.egc1/workspace.json'),row=workspace.entries[0];
    assert.deepEqual(row.tags,['drums','kick']);assert.equal(row.state,'ready');
    assert.equal(row.browserRoleEvidence.mode,'single');
    assert.equal((await f.pipeline.folder.json(`.egc1/semantic/${row.id}.json`)).roleEvidence.mode,'alternatives','retain original model uncertainty for evaluation');
    row.tags=['drums','kick','synth','bass','fx'];row.output.tags=[...row.tags];row.classification.hintMethod='token-hints-v2';
    await f.pipeline.folder.writeJson('.egc1/workspace.json',workspace);
    const files=[...f.files,...[...f.pipeline.folder.outputs].map(([path,file])=>({path,file}))];
    f.pipeline.inference.audio=async()=>{throw Error('Unexpected model call');};
    f.pipeline.inference.analyse=async()=>{throw Error('Unexpected analysis call');};
    events.length=0;await f.pipeline.run({...f,files});
    const first=events.find(event=>event.type==='output' && event.path==='.egc1/library.json');
    assert.equal(JSON.parse(await first.blob.text()).entries.length,0,'withdraw stale automatic hints before reclassification');
    const current=[...f.pipeline.rows.values()][0];
    assert.deepEqual(current.tags,['drums','kick']);assert.deepEqual(current.output.tags,['drums','kick']);
    assert.equal(f.pipeline.report.newEmbeddings,0);assert.equal(f.pipeline.report.reusedAnalysis,1);
    assert.equal(f.pipeline.report.bankSummary.banks[0][0].sounds,1);
    assert.equal(f.pipeline.report.bankSummary.banks[2][0].sounds,0);
});

test('older automatic vocal exclusions are refreshed from cached analysis without rerunning models',async()=>{
    const f=await fixture();f.files=[{...f.files[0],path:'vocal.wav'}];
    const analyse=f.pipeline.inference.analyse;
    f.pipeline.inference.analyse=async(...args)=>{
        const data=await analyse(...args);data.pitch.hasRoot=false;return data;
    };
    await f.pipeline.run(f);
    const workspace=await f.pipeline.folder.json('.egc1/workspace.json'),row=workspace.entries[0];
    assert(row.tags.includes('vocal'));
    row.state='needs-review';row.preparation.method='playable-phrase-and-attack-validation-v3';
    row.preparation.reasons=['uncertain-root','uncertain-attacks'];delete row.output;
    await f.pipeline.folder.writeJson('.egc1/workspace.json',workspace);
    await f.pipeline.folder.writeJson('.egc1/library.json',{version:1,entries:[]});
    f.pipeline.inference.analyse=()=>{throw Error('DSP must be reused');};
    f.pipeline.inference.audio=()=>{throw Error('Audio embeddings must be reused');};
    const files=[...new Map([...f.pipeline.folder.files,...f.pipeline.folder.outputs])].map(([path,file])=>({path,file}));
    await f.pipeline.run({...f,files});
    const current=(await f.pipeline.folder.json('.egc1/workspace.json')).entries[0];
    assert.equal(current.state,'ready');assert.deepEqual(current.preparation.reasons,[]);
    assert(current.preparation.warnings.includes('uncertain-root'));
    assert.equal(f.pipeline.report.reusedAnalysis,1);assert.equal(f.pipeline.report.newEmbeddings,0);
});

test('only loop candidates request beat inference and explicit loops bypass the sequence precheck',async()=>{
    const f=await fixture(),calls=[];f.options.beats=true;
    f.files=['kick.wav','unknown.wav','drum_loop.wav','bass.wav'].map((path,i)=>({path,
        file:new Blob([encodeWav([Float32Array.from({length:16000+i},(_,j)=>.2*Math.sin(j*.31))],8000)])}));
    const analyse=f.pipeline.inference.analyse;
    f.pipeline.inference.analyse=async(...args)=>{calls.push({beats:args[3],sequenceOnly:args[4].sequenceOnly});return analyse(...args);};
    await f.pipeline.run(f);
    assert.deepEqual(calls,[{beats:false,sequenceOnly:true},{beats:true,sequenceOnly:false},{beats:false,sequenceOnly:true},{beats:true,sequenceOnly:true}],'natural path order: bass, drum_loop, kick, unknown');
    assert.deepEqual(f.pipeline.report.beatAnalysis,{analysed:2,reused:0,skipped:2});
});

test('a skipped timing cache is upgraded when the hit is reclassified as a loop',async()=>{
    const f=await fixture(),calls=[];f.options.beats=true;f.files=f.files.slice(0,1);
    const analyse=f.pipeline.inference.analyse;
    f.pipeline.inference.analyse=async(...args)=>{calls.push(args[3]);return analyse(...args);};
    await f.pipeline.run(f);
    const row=[...f.pipeline.rows.values()][0];
    assert.equal((await f.pipeline.folder.json(`.egc1/browser/raw-analysis/${row.id}.json`)).browserBeatPolicy.reason,'assigned-one-shot');
    const saved=()=>[...new Map([...f.pipeline.folder.files,...f.pipeline.folder.outputs])].map(([path,file])=>({path,file}));
    await f.pipeline.run({...f,files:saved()});
    assert.deepEqual(calls,[false]);assert.equal(f.pipeline.report.reusedAnalysis,1);
    await f.pipeline.folder.writeJson('.egc1/overrides.json',{[row.id]:['loops','drum-loop']});
    await f.pipeline.run({...f,files:saved()});
    assert.deepEqual(calls,[false,true],'a loop override obtains actual beat analysis despite the cached hit');
    assert(!((await f.pipeline.folder.json(`.egc1/browser/raw-analysis/${row.id}.json`)).browserBeatPolicy?.skipped));
    assert.equal(f.pipeline.report.reusedEmbeddings,1);assert.equal(f.pipeline.report.newEmbeddings,0);
});

test('short unnamed hits skip beats, while disabling hints retains acoustic sequence checks',async()=>{
    const f=await fixture(),calls=[];f.options.beats=true;f.options.hints=false;
    f.files=[f.files[0],{path:'snare.wav',file:new Blob([encodeWav([Float32Array.from({length:16000},(_,j)=>.2*Math.sin(j*.31))],8000)])}];
    const analyse=f.pipeline.inference.analyse;
    f.pipeline.inference.analyse=async(...args)=>{calls.push({beats:args[3],sequenceOnly:args[4].sequenceOnly});return analyse(...args);};
    await f.pipeline.run(f);
    assert.deepEqual(calls,[{beats:false,sequenceOnly:true},{beats:true,sequenceOnly:true}]);
});

test('an unnamed sparse-event cache is reused until an explicit loop needs timing',async()=>{
    const f=await fixture(),calls=[];f.options.beats=true;f.options.hints=false;
    f.files=[{path:'unknown.wav',file:new Blob([encodeWav([Float32Array.from({length:16000},(_,j)=>.2*Math.sin(j*.31))],8000)])}];
    const analyse=f.pipeline.inference.analyse;
    f.pipeline.inference.analyse=async(...args)=>{
        calls.push(args[4].sequenceOnly);
        const data=await analyse(...args);
        return args[4].sequenceOnly ? {...data,browserBeatPolicy:{version:1,skipped:true,reason:'no-event-sequence'}} : data;
    };
    await f.pipeline.run(f);const row=[...f.pipeline.rows.values()][0];
    const saved=()=>[...new Map([...f.pipeline.folder.files,...f.pipeline.folder.outputs])].map(([path,file])=>({path,file}));
    await f.pipeline.run({...f,files:saved()});
    assert.deepEqual(calls,[true]);assert.equal(f.pipeline.report.beatAnalysis.skipped,1);
    await f.pipeline.folder.writeJson('.egc1/overrides.json',{[row.id]:['loops','drum-loop']});
    await f.pipeline.run({...f,files:saved()});
    assert.deepEqual(calls,[true,false]);assert.equal(f.pipeline.report.beatAnalysis.analysed,1);
    assert.equal(f.pipeline.report.reusedEmbeddings,1);
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

test('upgrading preparation does not temporarily withdraw or replace a human-approved cut',async()=>{
    const events=[],f=await fixture(event=>events.push(event));await f.pipeline.run(f);
    await approve(f,'kick.wav',{attackFrame:10,endFrame:700});
    const workspace=await f.pipeline.folder.json('.egc1/workspace.json');
    const approved=workspace.entries.find(row=>row.path==='kick.wav');
    const originalOutput=structuredClone(approved.output);
    approved.preparation.method='playable-phrase-and-attack-validation-v1';
    await f.pipeline.folder.writeJson('.egc1/workspace.json',workspace);
    const files=[...f.files,...[...f.pipeline.folder.outputs].map(([path,file])=>({path,file}))];
    events.length=0;
    await f.pipeline.run({...f,files});
    for(const event of events.filter(event=>event.type==='output' && event.path==='.egc1/library.json')) {
        assert(JSON.parse(await event.blob.text()).entries.some(row=>row.id===originalOutput.id),'approved audio stays published throughout reprocessing');
    }
    const current=(await f.pipeline.folder.json('.egc1/workspace.json')).entries.find(row=>row.path==='kick.wav');
    assert.deepEqual(current.output,originalOutput);
    assert.equal(current.state,'ready');
    assert.equal(f.pipeline.report.newEmbeddings,0);
});
