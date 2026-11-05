import test from 'node:test';
import assert from 'node:assert/strict';
import {Folder,metadataZip} from '../storage.js';
import {ReviewLibrary,REASONS} from '../review/library.js';
import {encodeWav,hashFile,hashBytes} from '../audio.js';
const json = value => new Blob([JSON.stringify(value)]);
const memory = () => { const values = new Map(); return {get:async key=>structuredClone(values.get(key)),set:async(key,value)=>{values.set(key,structuredClone(value));}}; };
async function fixture(legacy=false) {
 const prefix=legacy?'.toysampler':'.egc1';
 const wave=new Blob([encodeWav([new Float32Array(8000).fill(.25)],8000)]);
 const id=await hashFile(wave), sample='s-'+id;
 const analysis={version:1,id,pipeline:'test',pitch:{samples:8000,rate:8000},loop:{samples:8000,rate:8000,transients:[100]},vocal:{samples:8000,rate:8000}};
 const files=[{path:'pack/kick.wav',file:wave},{path:prefix+'/library.json',file:json({version:1,entries:[{id,path:'pack/kick.wav',state:'ready',channels:1,rate:8000,samples:8000,tags:['drums','kick']}]})},{path:prefix+'/entries/'+id+'.json',file:json(analysis)},{path:prefix+'/instrument-feedback.json',file:json({version:1,revision:3,items:{[sample]:{needsAttention:true,revision:3}}})}];
 const folder=new Folder(null,files),cache=memory();
 const library=await new ReviewLibrary(folder,cache).initialise();
 return {library,folder,cache,id,sample,files};
}
const payload={tags:['drums','kick'],certainty:'clear',quality:null,reasons:['loop-gap','wrong-root','too-short'],notes:'end needs work',boundaries:{attackFrame:120,endFrame:7900}};
test('legacy migration preserves source bytes, labels, notes and old path aliases',async()=>{
 const f=await fixture(true);
 assert(f.folder.outputs.has('.egc1/library.json'));
 assert.equal(f.library.items.size,1);
 assert.deepEqual(await f.folder.json('.toysampler/library.json'),await f.folder.json('.egc1/library.json'));
 assert(!f.folder.outputs.has('pack/kick.wav'));
 const archive=await metadataZip(f.folder.outputs);assert(archive.size>0);
});
test('blind session hides names and predictions, and stores all new issue codes',async()=>{
 const {library,sample}=await fixture();
 const item=library.session().items[0];
 for(const key of ['prediction','path','sourcePath','filename','policy','roleEvidence','analysisId']){assert(!(key in item),key);}
 assert(item.instrument.needsAttention);
 await library.save(sample,payload);
 const saved=library.export().reviews[sample];
 assert.equal(saved.boundaries.attackOffsetFrames,20);
 assert.equal(saved.boundaries.endOffsetFrames,-100);
 assert.equal(saved.notes,payload.notes);
 assert.deepEqual(saved.reasons,[...payload.reasons].sort());
 assert(REASONS.size===18);
 assert(!('prediction' in library.session().items[0].review));
 await assert.rejects(()=>library.save(sample,{...payload,reasons:['made-up']}));
});
test('independent review tabs merge the latest store before changing it',async()=>{
 const {library,folder,cache,sample}=await fixture();
 const other=await new ReviewLibrary(folder,cache).initialise();
 await library.save(sample,payload);
 await other.request('/api/reveal/'+sample,{});
 assert.equal(other.data.reviews[sample].notes,payload.notes);
 assert.equal(other.data.revision,2);
});
test('import/export, comparison, undo, resolving attention and reload preserve reviews',async()=>{
 const {library,folder,cache,sample}=await fixture();
 await library.save(sample,payload);
 const row=library.export().reviews[sample];
 await library.request('/api/comparison/'+sample,{reviewedAt:row.updatedAt,rating:'close'});
 assert.equal(library.export().reviews[sample].comparison.rating,'close');
 await library.save(sample,{...payload,notes:'later judgement'});
 await library.request('/api/undo',{});
 assert.equal(library.export().reviews[sample].notes,payload.notes);
 await library.request('/api/resolve-instrument/'+sample,{groups:[{id:sample,revision:3}]});
 const reloaded=await new ReviewLibrary(folder,cache).initialise();
 assert.equal(reloaded.flags(sample).needsAttention,false);
 assert.equal(reloaded.export().reviews[sample].notes,payload.notes);
 const exported=reloaded.export();
 exported.reviews[sample].notes='imported .toysampler is my literal note';
 exported.reviews[sample].updatedAt='2099-01-01T00:00:00Z';
 assert.equal(await library.importReviews(exported),1);
 assert.equal(library.export().reviews[sample].notes,exported.reviews[sample].notes);
 await assert.rejects(()=>library.importReviews({version:1,reviews:{[sample]:null}}));
});
test('failed metadata save retains the old judgement',async()=>{
 const {library,folder,sample}=await fixture();
 await library.save(sample,payload);
 const revision=library.data.revision;
 folder.writeJson=async()=>{throw new Error('disk full');};
 await assert.rejects(()=>library.save(sample,{...payload,notes:'lost'}),/disk full/);
 assert.equal(library.data.revision,revision);
 assert.equal(library.export().reviews[sample].notes,payload.notes);
});

// Separated samples and extracted kit hits must retain different review identities.
test('legacy region and kit paths retain stable IDs, marks and source playback',async()=>{
 const wave=new Blob([encodeWav([new Float32Array(8000).fill(.25)],8000)]);
 const original=new Blob([encodeWav([new Float32Array(24000).fill(.25)],8000)]);
 const id=await hashFile(wave),sourceId=await hashFile(original),prefix='.toysampler';
 const path=`${prefix}/regions/${sourceId}/8000-16000.wav`;
 const provenance={kind:'separated',sourceId,sourcePath:'original.wav',start:8000,end:16000,sourceSamples:24000,rate:8000};
 const regionId='s-'+await hashBytes(new TextEncoder().encode(`region-v1:${sourceId}:8000:16000:${id}`));
 const files=[{path:'original.wav',file:original},{path,file:wave},
  {path:prefix+'/library.json',file:json({version:1,entries:[{id,path,state:'ready',channels:1,rate:8000,samples:8000,tags:['synth','lead'],provenance}]})},
  {path:prefix+'/entries/'+id+'.json',file:json({version:1,id,pipeline:'test',pitch:{samples:8000,rate:8000},loop:{samples:8000,rate:8000,transients:[0]},vocal:{samples:8000,rate:8000}})},
  {path:prefix+'/kits/'+id+'/hit-01.wav',file:wave},
  {path:prefix+'/kits/'+id+'/kit.json',file:json({version:1,sourceId:id,rate:8000,sourcePath:path,hits:[{file:'hit-01.wav',start:0,end:8000}]})}];
 const folder=new Folder(null,files),library=await new ReviewLibrary(folder,memory()).initialise();
 assert.equal(library.items.size,2);
 assert(library.items.has(regionId));
 assert.equal(library.item(regionId).origin,'separated');
 assert.equal((await folder.json('.egc1/library.json')).entries[0].path,path.replace('.toysampler','.egc1'));
 const hit=[...library.items.values()].find(item=>item.kind==='hit');
 assert.notEqual(hit.id,regionId);
 assert.equal(hit.sourceKey,sourceId);
 assert.equal((await library.audio('/api/source/'+regionId)).headers.get('content-length'),null);
 assert.equal(await hashFile(await(await library.audio('/api/source/'+regionId)).blob()),sourceId);
 await library.save(regionId,{...payload,quality:'keep',boundaries:{attackFrame:8100,endFrame:15900}});
 assert.equal(library.export().reviews[regionId].boundaries.attackOffsetFrames,100);
 assert.equal(library.export().reviews[regionId].boundaries.endOffsetFrames,-100);
});

test('changed audio is rejected before playback',async()=>{
 const {library,folder,sample}=await fixture();
 folder.files.set('pack/kick.wav',new Blob(['different audio']));
 await assert.rejects(()=>library.audio('/api/audio/'+sample),/changed since processing/);
});

test('review migration shares the processor write lock without reacquiring it',async()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator'),locks=[];
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(name,run)=>{locks.push(name);return run();}}}});
 try { await fixture(true); assert.deepEqual(locks,['egc-classifier-write']); }
 finally { if(previous){Object.defineProperty(globalThis,'navigator',previous);}else{delete globalThis.navigator;} }
});
