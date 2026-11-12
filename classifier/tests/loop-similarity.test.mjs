import test from 'node:test';
import assert from 'node:assert/strict';
import {Folder} from '../storage.js';
import {encodeWav,hashFile} from '../audio.js';
import {loopFingerprint,compareLoops,selectLoopRepresentatives,publishWorkspace} from '../preparation.js';
const rate=8000;
function groove({gain=1,fill=false,offset=0,pattern=[0,.5,1,1.5]}={}) {
    const wave=new Float32Array(rate*2);
    for(const at of pattern) {
        const begin=Math.round((at+offset)*rate);
        for(let i=0;i<rate*.15 && begin+i<wave.length;i++) {
            wave[begin+i]+=gain*.6*(Math.sin(i*.071)+.15*Math.sin(i*1.37))*Math.exp(-i/200);
        }
    }
    if(fill) { for(let i=0;i<rate*.1;i++){wave[Math.round(1.8*rate)+i]+=.1*Math.sin(i*.63)*Math.exp(-i/200);} }
    return wave;
}
const fp=options=>loopFingerprint(groove(options),rate);
async function row(folder,path,audio,extra={}) {
    const file=new Blob([encodeWav([audio],rate)]),id=await hashFile(file);
    folder.files.set(path,file);
    return {id,path,state:'ready',tags:['loops','drum-loop'],rate,samples:audio.length,channels:1,bytes:file.size,...extra};
}
test('near identical loops match despite level edits and a small onset offset',()=>{
    assert(compareLoops(fp(),fp({gain:.3})));
    assert(compareLoops(fp(),fp({offset:.001})));
});
test('similar kit timbres with changed rhythm, a unique fill or different phrase length survive',()=>{
    assert.equal(compareLoops(fp(),fp({pattern:[0,.25,.75,1.5]})),null);
    assert.equal(compareLoops(fp(),fp({fill:true})),null);
    const shortened=groove().slice(0,Math.round(rate*.7));
    assert.equal(compareLoops(fp(),loopFingerprint(shortened,rate)),null);
    assert.equal(compareLoops(loopFingerprint(new Float32Array(rate),rate),loopFingerprint(new Float32Array(rate),rate)),null);
});
test('publication keeps one deterministic representative and preserves alternative audio and provenance',async()=>{
    const folder=new Folder(null),first=await row(folder,'first.wav',groove()),second=await row(folder,'second.wav',groove({gain:.3}));
    const workspace={version:1,entries:[second,first]};
    await publishWorkspace(folder,workspace);
    assert.equal((await folder.json('.egc1/library.json')).entries.length,1);
    assert.equal(second.duplicateOf.id,first.id);
    assert.equal((await folder.json('.egc1/workspace.json')).entries.length,2);
    assert.equal(await folder.file(second.path),folder.files.get(second.path));
    assert.equal(workspace.loopSimilarity.excluded,1);
    await publishWorkspace(folder,workspace);
    assert.equal((await folder.json('.egc1/library.json')).entries[0].id,first.id);
});
test('approving a variant selects it; rejecting the representative promotes a remaining eligible loop',async()=>{
    const folder=new Folder(null),a=await row(folder,'a.wav',groove()),b=await row(folder,'b.wav',groove({gain:.3}));
    const workspace={version:1,entries:[a,b]};
    await publishWorkspace(folder,workspace);
    b.admission={state:'approved',decidedAt:'2026-11-12T12:00:00Z'};
    await publishWorkspace(folder,workspace);
    assert.equal((await folder.json('.egc1/library.json')).entries[0].id,b.id);
    assert.equal(a.duplicateOf.id,b.id);
    b.state='rejected';
    await publishWorkspace(folder,workspace);
    assert.equal((await folder.json('.egc1/library.json')).entries[0].id,a.id);
    assert(!a.duplicateOf);
});
test('comparison spans parent collection packs and respects loop category boundaries',async()=>{
    const folderA=new Folder(null),folderB=new Folder(null);
    const a=await row(folderA,'same.wav',groove()),b=await row(folderB,'variation.wav',groove({gain:.3}));
    const vocal=await row(folderB,'vocal.wav',groove(),{tags:['loops','vocal-loop']});
    const summary=await selectLoopRepresentatives([{folder:folderB,workspace:{entries:[b,vocal]},pack:'B'},{folder:folderA,workspace:{entries:[a]},pack:'A'}]);
    assert.equal(summary.excluded,1);assert.equal(summary.retained,2);
    assert.equal(b.duplicateOf.pack,'A');assert(!vocal.duplicateOf);
});

test('different lengths merge only when every repeat matches; a changed final phrase stays',()=>{
    const short=groove(),long=new Float32Array(short.length*2);long.set(short);long.set(short,short.length);
    assert.equal(compareLoops(loopFingerprint(short,rate),loopFingerprint(long,rate)).repeats,2);
    long.set(groove({fill:true}),short.length);
    assert.equal(compareLoops(loopFingerprint(short,rate),loopFingerprint(long,rate)),null);
});

test('instrument favourites win automatic selection and attention-marked representatives cannot hide good alternatives',async()=>{
    const folder=new Folder(null),a=await row(folder,'a.wav',groove()),b=await row(folder,'b.wav',groove({gain:.3}));
    const workspace={version:1,entries:[a,b]};
    await folder.writeJson('.egc1/instrument-feedback.json',{version:1,items:{['s-'+b.id]:{favourite:true}}});
    await publishWorkspace(folder,workspace);
    assert.equal((await folder.json('.egc1/library.json')).entries[0].id,b.id);
    await folder.writeJson('.egc1/instrument-feedback.json',{version:1,items:{['s-'+b.id]:{favourite:true,needsAttention:true,attentionToken:'flag'}}});
    await publishWorkspace(folder,workspace);
    assert.equal((await folder.json('.egc1/library.json')).entries[0].id,a.id);
    assert.equal(b.state,'needs-review');assert(b.preparation.reasons.includes('instrument-attention'));
});
