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
test('pads, leads and bass retain uncertain pitch and attack as warnings while other synth roles require review',()=>{
    const wave=new Float32Array(rate);burst(wave,rate*.02,.8,120);
    const candidates=Array.from({length:12},(_,i)=>Math.round(rate*(.02+i*.006)));
    const data={pitch:{hasRoot:false},loop:{transients:candidates}};
    for(const role of ['pad','lead','bass']) {
        const synth=assessPreparation([wave],rate,data,['synth',role]);
        assert.deepEqual(synth.reasons,[]);
        assert.deepEqual(synth.warnings,['uncertain-root','uncertain-attacks']);
        assert(synth.attacks.rejected.length>5,'false decay chops are still rejected');
    }
    for(const tags of [['synth','keys'],['synth']]) {
        const synth=assessPreparation([wave],rate,data,tags);
        assert(synth.reasons.includes('uncertain-root'));
        assert(synth.reasons.includes('uncertain-attacks'));
    }
    const ambiguous=assessPreparation([wave],rate,data,['synth','pad'],{mode:'alternatives'});
    assert(ambiguous.reasons.includes('uncertain-category'));
    const silent=assessPreparation([new Float32Array(rate)],rate,{pitch:{hasRoot:false},loop:{transients:[]}},['synth','pad']);
    assert(silent.reasons.includes('silent-audio'));
});
test('real fast repeated attacks remain candidates instead of being removed by a fixed long interval',()=>{
    const wave=new Float32Array(rate), points=[rate*.02,rate*.028];
    for(const start of points){for(let i=0;i<rate*.002;i++){wave[start+i]=.7*Math.sin(i*1.9)*Math.exp(-i/(rate*.0004));}}
    const result=validateAttacks(wave,rate,points);
    assert(result.accepted.some(at=>Math.abs(at-points[1])<2));
});
test('vocals retain uncertain root and attacks as warnings without bypassing phrase or signal checks',()=>{
    const wave=new Float32Array(rate);burst(wave,rate*.02,.8,120);
    const candidates=Array.from({length:12},(_,i)=>Math.round(rate*(.02+i*.006)));
    const data={pitch:{hasRoot:false},loop:{transients:candidates,beats:[]}};
    for(const tags of [['vocal'],['vocal','vocal-note'],['synth','vocal','vocal-note']]) {
        const vocal=assessPreparation([wave],rate,data,tags);
        assert.deepEqual(vocal.reasons,[]);
        assert.deepEqual(vocal.warnings,['uncertain-root','uncertain-attacks']);
        assert(vocal.attacks.rejected.length>5);
    }
    const loop=assessPreparation([wave],rate,data,['loops','vocal-loop']);
    assert.deepEqual(loop.reasons,['uncertain-loop-phrase']);
    assert(loop.warnings.includes('uncertain-root'));
    assert(!loop.reasons.includes('uncertain-attacks'));
    assert(assessPreparation([wave],rate,data,['vocal'],{mode:'alternatives'}).reasons.includes('uncertain-category'));
    assert(assessPreparation([new Float32Array(rate)],rate,data,['vocal']).reasons.includes('silent-audio'));
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

test('missed and subdivided model beats retain the first usable attack and stop before the extra hit',()=>{
    const period=rate*.5,start=Math.round(rate*.2),wave=new Float32Array(start+period*9),attacks=[];
    for(let i=0;i<=8;i++){const at=start+i*period;burst(wave,at,.7,90);attacks.push(at);}
    const beats=Array.from({length:8},(_,i)=>start+(i+1)*period+Math.round(rate*.012));
    beats.splice(2,0,start+period*2.5);
    const phrase=findLoopPhrase(wave,rate,beats,attacks);
    assert(phrase);assert(Math.abs(phrase.start-start)<4);
    assert(Math.abs(phrase.end-(start+8*period))<rate*.007);
    assert.equal(phrase.pulses,8);
});

test('a sparse detector with a missed beat can still support a four-beat phrase',()=>{
    const period=Math.round(rate*.44),start=320,wave=new Float32Array(start+period*4+rate*.15),attacks=[];
    for(let i=0;i<=4;i++){const at=start+i*period;burst(wave,at,.7,110);attacks.push(at);}
    const phrase=findLoopPhrase(wave,rate,[start+180,start+period+180,start+3*period+180],attacks);
    assert(phrase);assert.equal(phrase.pulses,4);
    assert(Math.abs(phrase.end-(start+4*period))<rate*.007);
});

test('a rejected tail candidate warns about chops without withholding a supported whole loop',()=>{
    const period=rate*.5,start=320,wave=new Float32Array(start+period*4+rate*.15),attacks=[];
    for(let i=0;i<=4;i++){const at=start+i*period;burst(wave,at,.7,120);attacks.push(at);}
    const data={pitch:{hasRoot:false},loop:{beats:attacks,downbeats:[start,start+period*4],transients:[...attacks,start+rate*.025].sort((a,b)=>a-b)}};
    const result=assessPreparation([wave],rate,data,['loops','drum-loop']);
    assert(result.phrase);assert(!result.reasons.length);
    assert(result.warnings.includes('uncertain-chop-map'));
    assert(!result.attacks.accepted.includes(start+rate*.025));
});

test('a lone ringing hit with spurious onset and beat candidates remains excluded as a loop',()=>{
    const wave=new Float32Array(rate*2);burst(wave,320,.8,120);
    const result=assessPreparation([wave],rate,{pitch:{hasRoot:false},loop:{beats:[320,8320,16320,24320],transients:[320,480,640,800,960]}},['loops','drum-loop']);
    assert(result.reasons.includes('uncertain-loop-phrase'));
});

test('published loop clocks use the validated span instead of retaining missing or extra detector beats',async()=>{
    const {sliceAnalysis}=await import('../preparation.js');
    const role={samples:40000,rate,transients:[1000,9000,17000,25000,33000],beats:[9500,17500,21500,33500],downbeats:[9500],gateStarts:[1000],gateStrengths:[1]};
    const result=sliceAnalysis({loop:role},1000,33000,'output',1,{phrase:{pulses:4,confidence:.9}});
    assert.deepEqual(result.loop.beats,[0,8000,16000,24000]);
    assert.equal(result.loop.beatPeriod,8000);
    assert.equal(result.loop.beatDetector,'validated-performed-phrase-grid-v2');
    assert.equal(result.loop.loopEndSample,32000);
});

test('a complete three-beat phrase is kept instead of forcing a four-beat or half-phrase cut',()=>{
    const period=rate*.5,start=320,wave=new Float32Array(start+period*3+rate*.15),attacks=[];
    for(let i=0;i<=3;i++){const at=start+i*period;burst(wave,at,.7,i%3===0?90:500);attacks.push(at);}
    const phrase=findLoopPhrase(wave,rate,attacks,attacks,signalFacts(wave,rate),[start,start+period*3]);
    assert(phrase);assert.equal(phrase.pulses,3);
    assert(Math.abs(phrase.end-(start+3*period))<rate*.007);
});

test('a melodic loop needs matching performed context beyond its rhythmic grid',()=>{
    const period=rate*.5,start=320,wave=new Float32Array(start+period*4+rate*.15),attacks=[];
    for(let i=0;i<=4;i++){const at=start+i*period;burst(wave,at,.7,i===4?2400:120);attacks.push(at);}
    const data={pitch:{hasRoot:true},loop:{beats:attacks,downbeats:[start,start+period*4],transients:attacks}};
    const result=assessPreparation([wave],rate,data,['loops','melodic-loop']);
    assert(result.phrase,'retain a proposed cut for review');
    assert(result.reasons.includes('uncertain-loop-phrase'),'a rhythmic grid alone cannot establish melodic closure');
    assert(result.phrase.contextSimilarity<.95);
});
