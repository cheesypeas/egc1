import test from 'node:test';
import assert from 'node:assert/strict';
import {Folder} from '../storage.js';
import {summariseInventory,readCatalogue} from '../review/inventory.js';
import {Collection} from '../review/collection.js';
const taxonomy={drums:['kick','snare'],synth:['bass','pad']};
const json=value=>new Blob([JSON.stringify(value)]);
const catalogue=(id,tags)=>({ready:[{id,tags,kind:'sample'}],pending:[],excluded:[]});
const memory=()=>{const data=new Map();return {get:async key=>data.get(key),set:async(key,value)=>data.set(key,value)};};
test('ready totals deduplicate audio across sibling folders and preserve empty categories',()=>{
 const a=catalogue('same',['drums','kick']),b=catalogue('same',['drums','snare']);
 b.ready.push({id:'hit',tags:['drums','kick'],kind:'hit'});b.pending.push({id:'pending',tags:['synth','bass']});
 const stats=summariseInventory([a,b],taxonomy);
 assert.equal(stats.ready,2);assert.equal(stats.samples,1);assert.equal(stats.hits,1);
 assert.equal(stats.categories.kick.ready,2);assert.equal(stats.categories.snare.ready,1);
 assert.deepEqual(stats.categories.pad,{ready:0,pending:0,excluded:0});
 assert.equal(stats.categories.bass.pending,1);assert.equal(stats.categories.bass.ready,0);
});
test('saved catalogue counts exclude pending candidates and include legacy kit hits',async()=>{
 const audio=new Blob(['hit']), id='a'.repeat(64);
 const manifest={version:1,entries:[{id,state:'ready',path:'loop.wav',tags:['drums']}]};
 const folder=new Folder(null,[{path:'loop.wav',file:new Blob(['loop'])},{path:'.toysampler/library.json',file:json(manifest)},
  {path:`.toysampler/kits/${id}/kit.json`,file:json({version:1,sourceId:id,hits:[{file:'hit.wav'}]})},
  {path:`.toysampler/kits/${id}/hit.wav`,file:audio}]);
 const inventory=await readCatalogue(folder);
 assert.equal(inventory.ready.length,2);
 assert(!folder.outputs.size,'reading the parent must not migrate sibling metadata');
});
test('collection preserves independent folder outputs and updates totals without counting saved judgements as ready',async()=>{
 const root={name:'Sources',files:[]};
 for(const name of ['A','B']) {
  const id=name.toLowerCase().repeat(64), file=json({version:1,entries:[{id,state:'ready',path:'sound.wav',tags:['drums','kick']}]});
  root.files.push({path:`${name}/.egc1/library.json`,file},{path:`${name}/sound.wav`,file:new Blob(['sound'])});
 }
 root.files.push({path:'Unprepared/sound.wav',file:new Blob(['original'])});
 const collection=new Collection(memory(),taxonomy,()=>{});
 await collection.attach(root,null);
 assert.equal(collection.summary().ready,2);assert.equal(collection.unprepared.length,1);
 const pack=await collection.open('A'),folder=new Folder(null,pack.files);
 await folder.writeJson('.egc1/library.json',{version:1,entries:[]});
 await folder.writeJson('.egc1/workspace.json',{version:1,entries:[{id:'candidate',state:'needs-review',tags:['synth','bass']}]});
 await collection.updateCurrent({...pack,folder});
 assert.equal(collection.currentPath,'A');assert.equal(collection.summary().ready,1);assert.equal(collection.summary().categories.bass.pending,1);
 const other=await collection.open('B');assert.equal(other.collectionPath,'B');
 await collection.refresh(null);
 assert.equal(collection.summary().ready,1,'refresh retains changed metadata in download mode');
 assert.equal((await collection.open('A')).folder,folder);
});
test('unreadable sibling metadata is reported instead of becoming an empty prepared library',async()=>{
 const collection=new Collection(memory(),taxonomy,()=>{});
 await collection.attach({name:'Parent',files:[{path:'broken/.egc1/library.json',file:new Blob(['not json'])}]},null);
 assert.equal(collection.catalogues.length,1);assert(collection.catalogues[0].error);
 assert.equal(collection.summary().ready,0);
});
