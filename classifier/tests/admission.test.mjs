import test from 'node:test';
import assert from 'node:assert/strict';
import {Folder,validAnalysis} from '../storage.js';
import {encodeWav,hashFile,audioInfo,readWav} from '../audio.js';
import {ReviewLibrary} from '../review/library.js';
import {publishWorkspace,reviewIdentity} from '../preparation.js';

function analysis(frames,rate=8000) {
    const role=version=>({version:1,analysisVersion:version,samples:frames,rate,hasRoot:true,root:60,confidence:1,
        transients:[0],beats:[],downbeats:[],gateVersion:1,gateStarts:[0],gateStrengths:[.7]});
    return {version:1,pipeline:'test',channels:1,pitch:role(5),acousticPitch:role(5),loop:role(8),
        vocal:{...role(2),vocalStarts:[0],vocalDefaults:[0]}};
}
async function fixture(state='needs-review') {
    const rate=8000, wave=new Blob([encodeWav([Float32Array.from({length:8000},(_,i)=>.3*Math.sin(i*.37))],rate)]),id=await hashFile(wave);
    const row={id,path:'source.wav',state,rate,samples:8000,channels:1,bytes:wave.size,tags:['drums','snare'],
        preparation:{reasons:['uncertain-attacks'],bounds:{start:0,end:8000}}};
    const folder=new Folder(null,[{path:row.path,file:wave}]);
    await folder.writeJson(`.egc1/entries/${id}.json`,{...analysis(8000),id});
    await publishWorkspace(folder,{version:1,entries:[row]});
    const values=new Map(),cache={get:async key=>values.get(key),set:async(key,value)=>values.set(key,structuredClone(value))};
    const library=await new ReviewLibrary(folder,cache,()=>{},{analyse:async(channels,rate)=>analysis(channels[0].length,rate)}).initialise();
    const sample='s-'+id;
    const payload={tags:['drums','kick'],quality:'reject',certainty:'clear',reasons:['attack'],notes:'corrected',boundaries:{attackFrame:100,endFrame:7000}};
    return {folder,library,sample,payload,id,wave,cache};
}
test('a folder with only excluded sounds opens for review; saving does not admit it',async()=>{
    const f=await fixture();
    assert.equal(f.library.session().items.length,1);
    assert.equal(f.library.session().items[0].publication,'needs-review');
    await f.library.save(f.sample,f.payload);
    assert.deepEqual((await f.folder.json('.egc1/library.json')).entries,[]);
    const reviewedAt=f.library.export().reviews[f.sample].updatedAt;
    await f.library.admit(f.sample,{reviewedAt,transients:[100,3000]});
    const manifest=await f.folder.json('.egc1/library.json'),out=manifest.entries[0];
    assert.equal(out.state,'ready');assert.equal(out.samples,6900);assert.equal(out.channels,1);
    assert.deepEqual(out.tags,['drums','kick']);
    assert.equal(out.provenance.start,100);assert.equal(out.provenance.end,7000);
    assert.equal(await hashFile(await f.folder.file('source.wav')),f.id);
    const info=await audioInfo(await f.folder.file(out.path)),data=await f.folder.json(`.egc1/entries/${out.id}.json`);
    assert(validAnalysis(data,out.id,'test',info));
    assert.deepEqual(data.loop.transients,[0,2900]);
    const log=f.library.export().admissions[f.sample][0];
    assert.deepEqual(log.originalPrediction,['drums','snare']);assert.equal(log.judgement.quality,'reject');
    const reloaded=await new ReviewLibrary(f.folder,f.cache).initialise();
    assert.equal(reloaded.session().items[0].publication,'ready');
});
test('fresh human flags withdraw an accepted sound; rejection and imports do not republish it',async()=>{
    const f=await fixture('ready');
    assert.equal((await f.folder.json('.egc1/library.json')).entries.length,1);
    await f.library.save(f.sample,f.payload);
    assert.equal((await f.folder.json('.egc1/library.json')).entries.length,0);
    const reviewedAt=f.library.export().reviews[f.sample].updatedAt;
    await f.library.admit(f.sample,{reviewedAt},true);
    assert.equal((await f.folder.json('.egc1/workspace.json')).entries[0].state,'rejected');
    const exported=f.library.export();
    await f.library.importReviews(exported);
    assert.equal((await f.folder.json('.egc1/library.json')).entries.length,0);
    assert.equal(f.library.export().admissions[f.sample][0].state,'rejected');
});
test('stale approval, missing root/beat correction, invalid chops and changed source fail closed',async()=>{
    const f=await fixture();await f.library.save(f.sample,f.payload);
    const reviewedAt=f.library.export().reviews[f.sample].updatedAt;
    await assert.rejects(()=>f.library.admit(f.sample,{reviewedAt:'old',transients:[100]}),/saved revision/);
    await assert.rejects(()=>f.library.admit(f.sample,{reviewedAt,transients:[0]}),/inside the marked phrase/);
    await f.library.save(f.sample,{...f.payload,tags:['synth','bass'],reasons:['wrong-root']});
    const current=f.library.export().reviews[f.sample].updatedAt;
    await assert.rejects(()=>f.library.admit(f.sample,{reviewedAt:current,transients:[100]}),/corrected root/);
    await f.library.admit(f.sample,{reviewedAt:current,transients:[100],root:43});
    const out=(await f.folder.json('.egc1/library.json')).entries[0];
    assert.equal((await f.folder.json(`.egc1/entries/${out.id}.json`)).pitch.root,43);
    f.folder.files.set('source.wav',new Blob(['changed']));
    await assert.rejects(()=>f.library.admit(f.sample,{reviewedAt:current,transients:[100],root:43}),/Original audio changed/);
});
test('a failed final publication can be retried without adding unapproved audio',async()=>{
    const f=await fixture();await f.library.save(f.sample,f.payload);
    const reviewedAt=f.library.export().reviews[f.sample].updatedAt;
    const write=f.folder.writeJson.bind(f.folder);
    f.folder.writeJson=async(path,value)=>{if(path.endsWith('library.json')&&value.entries.length){throw Error('disk full');}return write(path,value);};
    await assert.rejects(()=>f.library.admit(f.sample,{reviewedAt,transients:[100]}),/disk full/);
    assert.equal((await f.folder.json('.egc1/library.json')).entries.length,0);
    f.folder.writeJson=write;
    await f.library.admit(f.sample,{reviewedAt,transients:[100]});
    assert.equal((await f.folder.json('.egc1/library.json')).entries.length,1);
});

test('a flagged kit hit is removed from the kit and can be approved as a corrected standalone sound',async()=>{
    const f=await fixture('ready');
    const raw=await readWav(f.wave,await audioInfo(f.wave),0,4000);
    const hit=new Blob([encodeWav(raw,8000)]),hash=await hashFile(hit);
    await f.folder.write(`.egc1/kits/${f.id}/hit-01.wav`,hit);
    await f.folder.writeJson(`.egc1/kits/${f.id}/kit.json`,{version:1,sourceId:f.id,rate:8000,hits:[{file:'hit-01.wav',start:0,end:4000,id:hash,browserTags:['drums','snare']}]});
    await f.library.initialise();
    const item=[...f.library.items.values()].find(item=>item.kind==='hit');assert(item);
    await f.library.save(item.id,{...f.payload,boundaries:{attackFrame:100,endFrame:3000}});
    assert.deepEqual((await f.folder.json(`.egc1/kits/${f.id}/kit.json`)).hits,[]);
    assert.equal((await f.folder.json('.egc1/library.json')).entries.length,1,'the valid source is retained');
    const reviewedAt=f.library.export().reviews[item.id].updatedAt;
    await f.library.admit(item.id,{reviewedAt,transients:[100]});
    assert.equal((await f.folder.json('.egc1/library.json')).entries.length,2);
    await f.library.initialise();
    assert.equal(f.library.item(item.id).publication,'ready');
    assert.equal(f.library.item(item.id).kind,'hit');
});

test('instrument flags on a cropped published identity map back to its review candidate',async()=>{
    const f=await fixture();await f.library.save(f.sample,f.payload);
    await f.library.admit(f.sample,{reviewedAt:f.library.export().reviews[f.sample].updatedAt,transients:[100]});
    const output=(await f.folder.json('.egc1/library.json')).entries[0],key=await reviewIdentity(output);
    assert.notEqual(key,f.sample);
    await f.folder.writeJson('.egc1/instrument-feedback.json',{version:1,items:{[key]:{revision:3,needsAttention:true}}});
    await f.library.initialise();
    assert(f.library.flags(f.sample).needsAttention);
    assert.equal((await f.folder.json('.egc1/library.json')).entries.length,0);
    await f.library.request('/api/resolve-instrument/'+f.sample,{groups:[{id:key,revision:3}]});
    assert(!f.library.flags(f.sample).needsAttention);
    assert.equal((await f.folder.json('.egc1/library.json')).entries.length,0,'resolving is separate from approval');
});
