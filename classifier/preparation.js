import {encodeWav, hashBytes, hashFile, audioInfo, readWav} from './audio.js';

export const PREPARATION = 'playable-phrase-and-attack-validation-v4';
const isVocal = tags => ['vocal','vocal-note','vocal-loop'].some(tag => tags.includes(tag));
export const allowsUncertainAnalysis = tags => isVocal(tags) || tags.includes('synth') && ['pad','lead','bass'].some(role => tags.includes(role));
export async function reviewIdentity(row) {
    if (row.reviewId) { return row.reviewId; }
    const p = row.provenance;
    return p ? 's-'+await hashBytes(new TextEncoder().encode(`region-v1:${p.sourceId}:${p.start}:${p.end}:${row.id}`)) : 's-'+row.id;
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] || 0;
const unique = values => [...new Set(values)].sort((a, b) => a - b);

export function signalFacts(audio, rate) {
    const hop = Math.max(1, Math.round(rate * .001)), energy = [], means = [];
    let peak = 0;
    for (let start = 0; start < audio.length; start += hop) {
        const end = Math.min(audio.length, start + hop);
        let sum = 0, power = 0;
        for (let i = start; i < end; i++) {
            if (!Number.isFinite(audio[i])) { throw new Error('Audio contains non-finite samples'); }
            sum += audio[i]; power += audio[i] ** 2; peak = Math.max(peak, Math.abs(audio[i]));
        }
        energy.push(power / (end - start)); means.push(sum / (end - start));
    }
    const quiet = energy.map((power, i) => [power, means[i]]).sort((a, b) => a[0] - b[0]);
    const dc = median(quiet.slice(0, Math.max(1, Math.floor(quiet.length * .1))).map(row => row[1]));
    // Three bands distinguish a fresh noisy attack over a ringing bass body.
    const prefix = [new Float64Array(audio.length + 1), new Float64Array(audio.length + 1), new Float64Array(audio.length + 1)];
    const lowA = 1 - Math.exp(-2 * Math.PI * 200 / rate), midA = 1 - Math.exp(-2 * Math.PI * 2000 / rate);
    let low = 0, mid = 0, previous = audio[0] - dc, highpass = 0;
    const dcPole = Math.exp(-2*Math.PI*20/rate);
    for (let i = 0; i < audio.length; i++) {
        const centered = audio[i]-dc;
        highpass = centered-previous+dcPole*highpass; previous = centered;
        const value = highpass;
        low += lowA * (value - low); mid += midA * (value - mid);
        const values = [low, mid - low, value - mid];
        for (let band = 0; band < 3; band++) { prefix[band][i + 1] = prefix[band][i] + values[band] ** 2; }
    }
    const power = (start, end, band = -1) => {
        start = Math.max(0, Math.min(audio.length, Math.round(start)));
        end = Math.max(start, Math.min(audio.length, Math.round(end)));
        if (end === start) { return 0; }
        return band < 0 ? prefix.reduce((sum, row) => sum + row[end] - row[start], 0) / (end - start) :
            (prefix[band][end] - prefix[band][start]) / (end - start);
    };
    const powers = energy.map((_, i) => power(i * hop, (i + 1) * hop));
    const maximum = Math.max(0, ...powers), floor = median([...powers].sort((a, b) => a - b).slice(0, Math.max(1, Math.floor(powers.length * .1))));
    const threshold = Math.max(1e-12, maximum * 1e-6, Math.min(floor * 16, maximum * .0004));
    let first = powers.findIndex(value => value > threshold), last = powers.length - 1;
    while (last >= 0 && powers[last] <= threshold) { last--; }
    if (first < 0 || maximum < 1e-10) { return {power, peak, dc, start: 0, end: audio.length, silent: true}; }
    const amplitude = Math.sqrt(threshold);
    let start = first * hop, end = Math.min(audio.length, (last + 1) * hop);
    while (start < end && Math.abs(audio[start] - dc) < amplitude) { start++; }
    while (end > start && Math.abs(audio[end - 1] - dc) < amplitude) { end--; }
    return {power, peak, dc, start: Math.max(0, start - 1), end: Math.max(start + 1, end), silent: false};
}

export function validateAttacks(audio, rate, candidates, facts = signalFacts(audio, rate)) {
    const accepted = facts.silent ? [] : [facts.start], rejected = [];
    for (const at of unique(candidates)) {
        if (at < facts.start + rate * .004 || at >= facts.end) { continue; }
        let supported = false;
        for (let band = 0; band < 3; band++) {
            const ratio = ms => {
                const width = rate * ms / 1000;
                return facts.power(at, at + width, band) / Math.max(1e-12, facts.power(at - width, at, band));
            };
            // A cycle in a ringing tail can rise in 2 ms while remaining flat
            // over 8/20 ms. Require evidence on both short and broader scales.
            const reset = ratio(2) >= 8 && ratio(20) >= .2 && facts.power(at-rate*.001,at,band) < facts.power(at,at+rate*.002,band)*.03;
            if (((ratio(2) >= 2 && ratio(8) >= 1.6 && ratio(20) >= 1.15) || reset) &&
                facts.power(at, at + rate * .008, band) > 1e-10) { supported = true; }
        }
        if (supported) { accepted.push(at); }
        else { rejected.push(at); }
    }
    const filtered = unique(accepted), periodic = new Set();
    // Dense periodic triggers can be texture or an actual roll. Preserve them
    // as review evidence instead of silently turning every ripple into a chop.
    for (let begin = 1; begin+4 < filtered.length;) {
        let end = begin+1;
        const step = filtered[end]-filtered[begin];
        if (step > rate*.025) { begin++; continue; }
        while (end+1 < filtered.length && Math.abs(filtered[end+1]-filtered[end]-step) <= step*.2) { end++; }
        if (end-begin >= 4) { for (let i=begin;i<=end;i++) { periodic.add(filtered[i]); } }
        begin = end+1;
    }
    return {accepted:filtered.filter(at=>!periodic.has(at)), rejected:unique([...rejected,...periodic])};
}

function fragmentSimilarity(facts, a, b, rate, length, window = rate*.05) {
    const width = Math.min(Math.round(window), length - Math.max(a, b));
    if (width < rate * .012) { return 0; }
    let dot = 0, aa = 0, bb = 0;
    const hop = Math.max(1, Math.round(rate * .002));
    for (let band = 0; band < 3; band++) {
        for (let i = 0; i + hop <= width; i += hop) {
            const x = Math.sqrt(facts.power(a + i, a + i + hop, band));
            const y = Math.sqrt(facts.power(b + i, b + i + hop, band));
            dot += x * y; aa += x * x; bb += y * y;
        }
    }
    return dot / Math.max(1e-12, Math.sqrt(aa * bb));
}

function audioContextSimilarity(audio, rate, phrase, facts, window) {
    if(audio.length-phrase.end<Math.min(window,rate*.15)) { return 0; }
    return fragmentSimilarity(facts,phrase.start,phrase.end,rate,audio.length,window);
}

function gridAgreement(beats, start, end, pulses, rate) {
    const period=(end-start)/pulses;
    const points=beats.filter(at=>at>=start-rate*.1 && at<=end+rate*.05);
    if(points.length<3) { return null; }
    let best=null;
    for(const divisor of [1,2]) {
        const step=period/divisor;
        const residuals=points.map(at=>((at-start)/step-Math.round((at-start)/step))*step);
        const shift=median(residuals.filter(value=>Math.abs(value)<=rate*.04));
        const errors=points.map(at=>Math.abs((at-start-shift)/step-Math.round((at-start-shift)/step))*step);
        const width=Math.max(rate*.018,step*.035);
        const matched=errors.filter(error=>error<width).length/points.length;
        const loss=errors.reduce((sum,error)=>sum+Math.min(error/width,3),0)/points.length;
        const score=matched-.15*loss-Math.abs(shift)/(rate*.04)*.03;
        if(!best || score>best.score) { best={score,matched,loss,divisor,shift}; }
    }
    return best;
}

function supportedBarSpan(downbeats, start, end, period, pulses, rate) {
    for(let i=1;i<downbeats.length;i++) {
        const bar=Math.round((downbeats[i]-downbeats[i-1])/period);
        if(bar<3 || bar>7 || pulses%bar!==0 || Math.abs(downbeats[i]-downbeats[i-1]-bar*period)>period*.15) { continue; }
        const width=Math.max(rate*.025,period*.06);
        if(downbeats.some(at=>Math.abs(at-start)<width) && downbeats.some(at=>Math.abs(at-end)<width)) { return true; }
    }
    return false;
}

function refinePhraseEnd(audio, rate, start, end, facts) {
    if(end===audio.length) { return end; }
    const radius=Math.round(rate*.006), hop=Math.max(1,Math.round(rate*.00025));
    let best={end,score:-Infinity};
    for(let at=Math.max(start+1,end-radius);at<Math.min(audio.length,end+radius);at+=hop) {
        const similarity=fragmentSimilarity(facts,start,at,rate,audio.length);
        const jump=Math.abs(audio[start]-audio[at-1])/Math.max(1e-9,facts.peak);
        const score=similarity-jump*.5-.015*Math.abs(at-end)/radius;
        if(score>best.score) { best={end:at,score}; }
    }
    return best.end;
}

export function findLoopPhrase(audio, rate, beats, attacks, facts = signalFacts(audio, rate), downbeats = [], verifiedAttacks = attacks) {
    if(facts.silent || beats.length<3) { return null; }
    // Raw beat predictions may contain missed beats or eighth notes. Assess
    // their agreement with each performed span, instead of multiplying one
    // quantised median interval into an increasingly inaccurate endpoint.
    const points=unique(attacks.filter(at=>at>=facts.start && at<facts.end));
    const boundaries=points.filter((at,i)=>i===0 || at-points[i-1]>rate*.02);
    const starts=unique([facts.start,...verifiedAttacks.filter(at=>at>=facts.start && at<facts.end)]).slice(0,32);
    const candidates=[];
    const quietEnd=facts.power(audio.length-rate*.005,audio.length)<Math.max(1e-10,facts.power(facts.start,facts.start+rate*.02)*.001);
    const ends=quietEnd ? [...boundaries,audio.length] : boundaries;
    for(const start of starts) {
        for(const roughEnd of ends) {
            const span=roughEnd-start;
            if(span<rate*.4) { continue; }
            for(let pulses=2;pulses<=Math.min(128,Math.floor(span/(rate*.27)));pulses++) {
                const period=span/pulses;
                if(period<rate*.27 || period>rate*1.2) { continue; }
                // Odd/non-binary spans need bar evidence; an extra detected
                // hit must not silently turn an eight-beat loop into seven.
                if(!Number.isInteger(Math.log2(pulses)) && !supportedBarSpan(downbeats,start,roughEnd,period,pulses,rate)) { continue; }
                const fit=gridAgreement(beats,start,roughEnd,pulses,rate);
                if(!fit || fit.matched<.7 || fit.loss>1.2 || (roughEnd===audio.length && fit.score<.85)) { continue; }
                const events=verifiedAttacks.filter(at=>at>=start && at<roughEnd);
                if(events.length<2 || events.at(-1)-events[0]<span*.4) { continue; }
                const coverage=span/Math.max(1,facts.end-facts.start);
                // Coverage favours a complete phrase over an equally plausible
                // half phrase; early starts keep a good first attack intact.
                const score=fit.score+.4*coverage-.12*Math.abs(Math.log2(period/(rate*.5)))+
                    (Number.isInteger(Math.log2(pulses)) ? .025 : 0)-
                    .35*(start-facts.start)/Math.max(1,facts.end-facts.start);
                candidates.push({start,roughEnd,pulses,score,fit});
            }
        }
    }
    candidates.sort((a,b)=>a.start-b.start || b.score-a.score || b.roughEnd-a.roughEnd);
    for(const candidate of candidates) {
        const {start,roughEnd,pulses,fit}=candidate;
        const end=refinePhraseEnd(audio,rate,start,roughEnd,facts);
        const seam=Math.abs(audio[start]-audio[end-1])/Math.max(1e-9,facts.peak);
        if(seam>.03) { continue; }
        return {method:'onset-anchored-grid-consensus-v2',start,end,pulses,period:(end-start)/pulses,
            observedPeriod:(roughEnd-start)/pulses,confidence:Math.max(0,Math.min(.99,fit.matched*(1-fit.loss*.1))),
            gridAgreement:fit.matched,gridResidual:fit.loss,similarity:fragmentSimilarity(facts,start,end,rate,audio.length)};
    }
    return null;
}

export function assessPreparation(channels, rate, data, tags, evidence = {}) {
    const facts = signalFacts(channels[0], rate), attacks = validateAttacks(channels[0], rate, data.loop.transients || [], facts);
    const reasons = [], warnings = [], optionalAnalysis = allowsUncertainAnalysis(tags);
    if (facts.silent) { reasons.push('silent-audio'); }
    if (!tags.length || tags.includes('unclassified') || evidence.mode === 'alternatives' ||
        (tags.includes('loops') && !tags.some(tag=>['drum-loop','melodic-loop','vocal-loop'].includes(tag)))) { reasons.push('uncertain-category'); }
    if ((tags.includes('synth') || isVocal(tags)) && !data.pitch.hasRoot) { (optionalAnalysis ? warnings : reasons).push('uncertain-root'); }
    let bounds = {start: facts.start, end: facts.end}, phrase = null;
    if (tags.includes('loops')) {
        phrase = findLoopPhrase(channels[0], rate, data.loop.beats || [], unique([...attacks.accepted, ...(data.loop.transients || [])]), facts, data.loop.downbeats || [], attacks.accepted);
        if (!phrase) { reasons.push('uncertain-loop-phrase'); }
        else {
            bounds = {start: phrase.start, end: phrase.end};
            if(!tags.includes('drum-loop')) {
                // Rhythm alone does not establish a melodic/vocal phrase join.
                // Require matching performed context beyond a single attack;
                // otherwise retain the proposed bounds for manual review.
                const window=Math.min(rate*.5,phrase.period*2);
                phrase.contextSimilarity=audioContextSimilarity(channels[0],rate,phrase,facts,window);
                if(phrase.contextSimilarity<.95) { reasons.push('uncertain-loop-phrase'); }
            }
        }
    }
    const uncertainAttacks=attacks.rejected.some(at=>at>=bounds.start && at<bounds.end);
    if (uncertainAttacks) {
        if (tags.includes('loops')) { warnings.push('uncertain-chop-map'); }
        else { (optionalAnalysis ? warnings : reasons).push('uncertain-attacks'); }
    }
    return {version: 4, method: PREPARATION, reasons, warnings, bounds, phrase, attacks, silent: facts.silent};
}

export function sliceAnalysis(data, start, end, id, channels, {transients = null, root = null, phrase = null, manual = false} = {}) {
    const result = structuredClone(data), samples = end - start;
    result.id = id; result.channels = channels;
    for (const name of ['pitch', 'acousticPitch', 'loop', 'vocal']) {
        const item = result[name];
        if (!item) { continue; }
        const strengths = new Map((item.gateStarts || []).map((at, i) => [at-start, item.gateStrengths?.[i] ?? 1]));
        item.samples = samples;
        for (const field of ['transients', 'beats', 'downbeats', 'vocalStarts', 'vocalDefaults']) {
            item[field] = unique((item[field] || []).filter(at => at >= start && at < end).map(at => at - start));
        }
        if (name !== 'pitch' && name !== 'acousticPitch' && transients) {
            item.transients = unique(transients.filter(at => at >= start && at < end).map(at => at - start));
        }
        if (name === 'pitch' && root !== null) { item.root = root; item.hasRoot = true; item.confidence = 1; }
        if (name === 'vocal') {
            if (!item.vocalStarts.length) { item.vocalStarts = [0]; }
            if (!item.vocalDefaults.length) { item.vocalDefaults = item.vocalStarts.slice(0, 8); }
        }
        const starts = name === 'vocal' ? item.vocalStarts : item.transients;
        item.gateVersion = 1; item.gateStarts = [...starts];
        item.gateStrengths = starts.map(at => strengths.get(at) ?? 1);
        item.beatPeriod = phrase ? samples / phrase.pulses : 0;
        item.barOrigin = 0; item.beatConfidence = phrase?.confidence || 0;
        // These are checked, performed phrase bounds. Publish their fitted grid
        // after cropping: retaining missed/extra raw detector beats would let a
        // native reader undo the validated timing when rebuilding its clock.
        if (phrase && !['pitch','acousticPitch'].includes(name)) {
            item.beats = Array.from({length:phrase.pulses},(_,i)=>Math.round(i*samples/phrase.pulses));
            item.downbeats = item.beats.filter((_,i)=>i%4===0);
            item.beatDetector = manual ? 'manual-phrase-beat-count-v1' : 'validated-performed-phrase-grid-v2';
        }
        item.eighths = Array.from({length: phrase ? phrase.pulses * 2 + 1 : 9}, (_, i) => Math.round(i * samples / (phrase ? phrase.pulses * 2 : 8)));
        if (name === 'loop') {
            item.loopBoundaryVersion = 2; item.loopEndSample = samples; item.loopEndConfidence = 0; item.loopPulseSamples = 0;
        }
    }
    return result;
}

export async function playableOutput(folder, row, data, channels, bounds, options = {}) {
    const {start, end} = bounds;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > row.samples) { throw new Error('Invalid playable bounds'); }
    const audio = [channels[0].slice(start, end)], bytes = encodeWav(audio, row.rate), id = await hashBytes(bytes);
    const source = row.provenance || {sourceId: row.id, sourcePath: row.path, sourceSamples: row.samples, start: 0};
    const a = source.start + start, b = source.start + end;
    const path = `.egc1/regions/${source.sourceId}/${a}-${b}-playable.wav`;
    const existing = await folder.file(path).catch(error=>{if(error.name==='NotFoundError'){return null;}throw error;});
    if (!existing || existing.size !== bytes.byteLength || await hashFile(existing) !== id) { await folder.write(path, new Blob([bytes], {type: 'audio/wav'})); }
    const analysis = sliceAnalysis(data, start, end, id, 1, options);
    const cached = await folder.json(`.egc1/entries/${id}.json`);
    if (JSON.stringify(cached) !== JSON.stringify(analysis)) { await folder.writeJson(`.egc1/entries/${id}.json`, analysis); }
    return {...row, id, path, bytes: bytes.byteLength, channels: 1, samples: end - start, state: 'ready',
        provenance: {kind: 'separated', sourceId: source.sourceId, sourcePath: source.sourcePath,
            sourceSamples: source.sourceSamples, rate: row.rate, start: a, end: b}, output: undefined, reviewId: undefined,
        preparation: {...row.preparation, bounds, method: PREPARATION}};
}

export async function readWorkspace(folder) {
    const saved = await folder.json('.egc1/workspace.json');
    if (saved && (saved.version !== 1 || !Array.isArray(saved.entries))) { throw new Error('Invalid preparation workspace'); }
    return saved || await folder.json('.egc1/library.json');
}


export const LOOP_SIMILARITY = 'left-waveform-and-three-band-envelope-v1';
const similarityCaches = new WeakMap();
const encoded = array => {
    const bytes = new Uint8Array(array.buffer), parts = [];
    for (let i=0;i<bytes.length;i+=8192) { parts.push(String.fromCharCode(...bytes.subarray(i,i+8192))); }
    return btoa(parts.join(''));
};
const decoded = (text, Type) => {
    const bytes = Uint8Array.from(atob(text), ch=>ch.charCodeAt(0));
    return new Type(bytes.buffer);
};

// Preserve timing and timbre evidence. Semantic embeddings alone would merge
// different grooves played on the same kit, and raw file hashes miss gain edits.
export function loopFingerprint(audio, rate) {
    const frequency=2000, envelopeRate=100, count=Math.ceil(audio.length*frequency/rate);
    const wave=new Float64Array(count), powers=Array.from({length:3},()=>new Float64Array(Math.ceil(audio.length*envelopeRate/rate)));
    const widths=new Uint32Array(count), envelopes=new Uint32Array(powers[0].length);
    const a=1-Math.exp(-2*Math.PI*200/rate), b=1-Math.exp(-2*Math.PI*2000/rate);
    let low=0, mid=0;
    for(let i=0;i<audio.length;i++) {
        const value=audio[i];
        if(!Number.isFinite(value)) { throw Error('Non-finite loop audio'); }
        const w=Math.floor(i*frequency/rate), e=Math.floor(i*envelopeRate/rate);
        wave[w]+=value;widths[w]++;envelopes[e]++;
        low+=a*(value-low);mid+=b*(value-mid);
        powers[0][e]+=low*low;powers[1][e]+=(mid-low)**2;powers[2][e]+=(value-mid)**2;
    }
    let maximum=0;
    for(let i=0;i<count;i++) { wave[i]/=widths[i];maximum=Math.max(maximum,Math.abs(wave[i])); }
    const quantised=Int16Array.from(wave,value=>Math.round(value/Math.max(maximum,1e-12)*32767));
    let energyMaximum=0;
    for(const band of powers) { for(let i=0;i<band.length;i++) { band[i]=Math.sqrt(band[i]/envelopes[i]);energyMaximum=Math.max(energyMaximum,band[i]); } }
    return {method:LOOP_SIMILARITY,seconds:audio.length/rate,wave:encoded(quantised),
        bands:powers.map(band=>encoded(Uint16Array.from(band,value=>Math.round(value/Math.max(energyMaximum,1e-12)*65535))))};
}

function correlation(a,b,lag=0,stride=1,start=0,end=a.length) {
    let aa=0,bb=0,ab=0;
    for(let i=Math.max(start,-lag);i<Math.min(end,b.length-lag);i+=stride) {
        const x=a[i],y=b[i+lag];aa+=x*x;bb+=y*y;ab+=x*y;
    }
    return {score:ab/Math.max(1e-12,Math.sqrt(aa*bb)),power:Math.max(aa,bb)};
}
const unpackFingerprint = value => ({...value,wave:decoded(value.wave,Int16Array),bands:value.bands.map(band=>decoded(band,Uint16Array))});
export function compareLoops(left,right) {
    if(left.method!==LOOP_SIMILARITY || right.method!==LOOP_SIMILARITY) { return null; }
    const a=typeof left.wave==='string' ? unpackFingerprint(left) : left;
    const b=typeof right.wave==='string' ? unpackFingerprint(right) : right;
    if(Math.abs(a.seconds-b.seconds)>Math.min(a.seconds,b.seconds)*.005) {
        const short=a.seconds<b.seconds ? a : b, long=short===a ? b : a;
        const repeats=Math.round(long.seconds/short.seconds);
        if(repeats<2 || repeats>8 || Math.abs(long.seconds/repeats-short.seconds)>short.seconds*.005) { return null; }
        let weakest=1,offset=null;
        for(let repeat=0;repeat<repeats;repeat++) {
            const slice=values=>values.subarray(Math.round(repeat*values.length/repeats),Math.round((repeat+1)*values.length/repeats));
            const comparison=compareLoops(short,{method:LOOP_SIMILARITY,seconds:long.seconds/repeats,wave:slice(long.wave),bands:long.bands.map(slice)});
            if(!comparison || (offset!==null && Math.abs(comparison.offsetMs-offset)>2)) { return null; }
            weakest=Math.min(weakest,comparison.correlation);offset=comparison.offsetMs;
        }
        return {correlation:weakest,offsetMs:offset,repeats};
    }
    const candidates=[];
    for(let lag=-16;lag<=16;lag++) { candidates.push({lag,score:correlation(a.wave,b.wave,lag,16).score}); }
    candidates.sort((x,y)=>y.score-x.score);
    for(const {lag} of candidates.slice(0,3)) {
        const whole=correlation(a.wave,b.wave,lag);
        if(whole.score<.995) { continue; }
        // A unique fill must not disappear under an otherwise identical loud
        // kick pattern. Every audible section and frequency band must agree.
        let matches=true;
        for(let part=0;part<8;part++) {
            const local=correlation(a.wave,b.wave,lag,1,Math.floor(part*a.wave.length/8),Math.floor((part+1)*a.wave.length/8));
            if(local.power>whole.power*.00001 && local.score<.98) { matches=false;break; }
        }
        if(!matches) { continue; }
        for(let band=0;band<3;band++) {
            const energy=correlation(a.bands[band],b.bands[band],Math.round(lag/20));
            if(energy.power>0 && energy.score<.98) { matches=false;break; }
        }
        if(matches) { return {correlation:whole.score,offsetMs:lag/2}; }
    }
    return null;
}

async function fingerprintFor(folder,row) {
    let cache=similarityCaches.get(folder);
    if(!cache) { cache={fingerprints:new Map(),pairs:new Map()};similarityCaches.set(folder,cache); }
    const output=row.output || row;
    if(!cache.fingerprints.has(output.id)) {
        const pending=(async()=>{
            const path=`.egc1/browser/loop-fingerprints/${output.id}.json`;
            let value=await folder.json(path);
            if(value?.method!==LOOP_SIMILARITY || value.id!==output.id || value.seconds!==output.samples/output.rate || typeof value.wave!=='string' || !Array.isArray(value.bands) || value.bands.length!==3 || value.bands.some(band=>typeof band!=='string') ||
                value.wave.length!==4*Math.ceil(Math.ceil(output.samples*2000/output.rate)*2/3)) {
                const file=await folder.file(output.path);
                if(!file) { throw Error('Loop audio is missing: '+output.path); }
                const info=await audioInfo(file);
                if(info.compressed) { return null; }
                const channels=await readWav(file,info);
                value={...loopFingerprint(channels[0],info.rate),id:output.id};
                await folder.writeJson(path,value);
            }
            return unpackFingerprint(value);
        })();
        cache.fingerprints.set(output.id,pending);
    }
    return cache.fingerprints.get(output.id);
}

// Compare each candidate against a retained representative, never against a
// discarded neighbour: A~B and B~C do not establish that A and C are duplicates.
export async function selectLoopRepresentatives(sources, progress=()=>{}) {
    const candidates=[];
    for(const source of sources) {
        const feedback=await source.folder.json('.egc1/instrument-feedback.json');
        const resolutions=(await source.folder.json('.egc1/instrument-resolutions.json'))?.resolutions || {};
        for(const row of source.workspace.entries) {
            delete row.duplicateOf;
            if(row.output) { delete row.output.duplicateOf; }
            if(row.state!=='ready' || !row.tags?.includes('loops')) { continue; }
            const aliases=new Set([await reviewIdentity(row)]);
            if(row.output) { aliases.add(await reviewIdentity({...row.output,reviewId:null})); }
            let favourite=false,attention=false;
            for(const [id,flag] of Object.entries(feedback?.items || {})) {
                if(!aliases.has(id) && !flag.members?.some(member=>aliases.has(member))) { continue; }
                favourite ||= Boolean(flag.favourite);
                const token=flag.attentionToken || `${id}:${flag.revision || 0}`;
                attention ||= Boolean(flag.needsAttention && resolutions[token]?.id!==id);
            }
            if(attention) {
                row.state='needs-review';
                row.preparation={...row.preparation,reasons:[...new Set([...(row.preparation?.reasons || []),'instrument-attention'])]};
                continue;
            }
            candidates.push({...source,row,favourite});
        }
    }
    const identity=item=>`${item.pack || ''}/${item.row.path}`;
    candidates.sort((a,b)=>Number(Boolean(b.row.admission))-Number(Boolean(a.row.admission)) ||
        String(b.row.admission?.decidedAt || '').localeCompare(a.row.admission?.decidedAt || '') ||
        Number(b.favourite)-Number(a.favourite) || identity(a).localeCompare(identity(b)));
    const representatives=[];
    let excluded=0,checked=0;
    for(const item of candidates) {
        progress(`Comparing similar loops · ${++checked} / ${candidates.length}`);
        const output=item.row.output || item.row, family=(item.row.tags || []).filter(tag=>['drum-loop','melodic-loop','vocal-loop','recorded'].includes(tag)).sort().join('/');
        const fingerprint=await fingerprintFor(item.folder,item.row);
        let match=null, evidence=null;
        if(fingerprint) {
            for(const candidate of representatives) {
                if(candidate.family!==family || !candidate.fingerprint) { continue; }
                const cache=similarityCaches.get(item.folder), key=output.id+':'+candidate.output.id;
                if(!cache.pairs.has(key)) { cache.pairs.set(key,compareLoops(fingerprint,candidate.fingerprint)); }
                const comparison=cache.pairs.get(key);
                if(comparison) { match=candidate;evidence=comparison;break; }
            }
        }
        if(match) {
            item.row.duplicateOf={method:LOOP_SIMILARITY,id:match.output.id,reviewId:await reviewIdentity(match.item.row),
                path:match.item.row.provenance?.sourcePath || match.item.row.path,pack:match.item.pack || '',...evidence};
            excluded++;
        } else { representatives.push({item,output,fingerprint,family}); }
    }
    return {method:LOOP_SIMILARITY,checked:candidates.length,retained:representatives.length,excluded};
}

export async function publishWorkspace(folder, workspace, {grouped=false,progress=()=>{}} = {}) {
    if (!grouped) { workspace.loopSimilarity=await selectLoopRepresentatives([{folder,workspace}],progress); }
    workspace.publicationPolicy = PREPARATION;
    const entries = workspace.entries.filter(row => row.state === 'ready' && !row.duplicateOf).map(row => row.output || row);
    const previous = await folder.json('.egc1/library.json');
    const allowed = new Set(entries.map(row => row.id));
    // Withdraw first. A failed subsequent write can withhold a sound but cannot
    // leave a newly flagged sound playable. Publish additions last.
    if (previous?.entries?.some(row => !allowed.has(row.id))) {
        await folder.writeJson('.egc1/library.json', {...previous, entries: previous.entries.filter(row => allowed.has(row.id))});
    }
    await folder.writeJson('.egc1/workspace.json', workspace);
    await folder.writeJson('.egc1/library.json', {...workspace, decisions:undefined, entries});
}

