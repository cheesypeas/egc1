import test from 'node:test';
import assert from 'node:assert/strict';
import {signalFacts,validateAttacks,findLoopPhrase,assessPreparation,publishWorkspace,playableOutput} from '../preparation.js';
import {Folder,validAnalysis,validEmbedding} from '../storage.js';
import {encodeWav,hashFile,audioInfo,readWav} from '../audio.js';
const rate=16000;
const burst=(audio,at,level=1,frequency=700)=>{
    for(let i=0;i<rate*.08 && at+i<audio.length;i++){audio[at+i]+=level*Math.sin(i*2*Math.PI*frequency/rate)*Math.exp(-i/(rate*.012));}
};
test('playable bounds remove guard silence without adding fixed pre/post roll',()=>{
    const wave=new Float32Array(rate);burst(wave,rate*.1,.7);
    const facts=signalFacts(wave,rate);
    assert(Math.abs(facts.start-rate*.1)<4);
    assert(facts.end<rate*.2 && facts.end>rate*.16);
    assert.equal(signalFacts(new Float32Array(rate).fill(.01),rate).silent,true,'DC is not an audible attack');
});
test('ringing decay candidates do not become repeated accepted chops',()=>{
    const wave=new Float32Array(rate);burst(wave,rate*.02,.8,120);
    const candidates=Array.from({length:12},(_,i)=>Math.round(rate*(.02+i*.006)));
    const result=validateAttacks(wave,rate,candidates);
    assert.equal(result.accepted.length,1);
    assert(result.rejected.length>5);
    const assessed=assessPreparation([wave],rate,{pitch:{hasRoot:false},loop:{transients:candidates}},['drums','kick']);
    assert(assessed.reasons.includes('uncertain-attacks'));
});
test('real fast repeated attacks remain candidates instead of being removed by a fixed long interval',()=>{
    const wave=new Float32Array(rate), points=[rate*.02,rate*.028];
    for(const start of points){for(let i=0;i<rate*.002;i++){wave[start+i]=.7*Math.sin(i*1.9)*Math.exp(-i/(rate*.0004));}}
    const result=validateAttacks(wave,rate,points);
    assert(result.accepted.some(at=>Math.abs(at-points[1])<2));
});
test('a quiet ghost under a loud decay remains review evidence if it cannot be verified',()=>{
    const wave=new Float32Array(rate), start=320, ghost=960;
    for(let i=0;i<rate*.3;i++){wave[start+i]+=.8*Math.sin(i*2*Math.PI*100/rate)*Math.exp(-i/(rate*.15));}
    for(let i=0;i<rate*.01;i++){wave[ghost+i]+=.04*Math.sin(i*2*Math.PI*3500/rate)*Math.exp(-i/(rate*.002));}
    const assessed=assessPreparation([wave],rate,{pitch:{hasRoot:false},loop:{transients:[start,ghost]}},['drums','kick']);
    assert(assessed.attacks.accepted.includes(ghost) || assessed.attacks.rejected.includes(ghost));
    if(assessed.attacks.rejected.includes(ghost)){assert(assessed.reasons.includes('uncertain-attacks'));}
});
test('loop search finds an interior phrase with multiple extra surrounding hits',()=>{
    const period=rate*.5, wave=new Float32Array(period*14), start=period*2;
    const beats=Array.from({length:12},(_,i)=>start+i*period);
    const attacks=[];
    for(let i=0;i<12;i++){const at=start+i*period;burst(wave,at,.7,i%4===0?80:600+i%3*100);attacks.push(at);}
    const phrase=findLoopPhrase(wave,rate,beats,attacks,signalFacts(wave,rate),[start,start+4*period,start+8*period]);
    assert(phrase);
    assert(phrase.start>=start && phrase.end<=start+12*period);
    assert.equal(phrase.pulses%4,0);
    assert(Math.abs(phrase.period-period)<2);
    assert(phrase.end<signalFacts(wave,rate).end,'extra tail events are outside the selected phrase');
});
test('uncertain loops and ambiguous categories are withheld',()=>{
    const wave=new Float32Array(rate);burst(wave,rate*.02,.8);
    const data={pitch:{hasRoot:false},loop:{transients:[rate*.02],beats:[]}};
    assert(assessPreparation([wave],rate,data,['loops','drum-loop']).reasons.includes('uncertain-loop-phrase'));
    assert(assessPreparation([wave],rate,data,['unclassified']).reasons.includes('uncertain-category'));
});
test('publication withdraws flagged sounds before attempting the workspace write',async()=>{
    const folder=new Folder(null), old={id:'old',state:'ready'};
    await folder.writeJson('.egc1/library.json',{version:1,entries:[old]});
    const write=folder.writeJson.bind(folder);
    folder.writeJson=async(path,value)=>{if(path.endsWith('workspace.json')){throw Error('disk full');}return write(path,value);};
    await assert.rejects(()=>publishWorkspace(folder,{version:1,entries:[{...old,state:'needs-review'}]}),/disk full/);
    assert.deepEqual((await folder.json('.egc1/library.json')).entries,[]);
});

test('left-channel cache migration reuses matching embeddings and rejects right-channel embeddings',()=>{
    const info={rate:8000,channels:2,frames:8000};
    const embedding={version:1,id:'a',frontend:'clap48k-r8brain-slaney-repeatpad-three-crops-web-v1',selectedChannel:0,
        modelSha256:'model',rate:8000,samples:8000,channels:2,peak:.2,vectors:[[1,...Array(511).fill(0)]]};
    const frontend='clap48k-r8brain-slaney-repeatpad-three-crops-left-web-v2';
    assert(validEmbedding(embedding,'a',info,frontend,'model'));
    assert(!validEmbedding({...embedding,selectedChannel:1},'a',info,frontend,'model'));
    assert(!validEmbedding({...embedding,frontend:'other'},'a',info,frontend,'model'));
});
