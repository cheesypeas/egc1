import {encodeWav, hashBytes, hashFile} from './audio.js';

export const PREPARATION = 'playable-phrase-and-attack-validation-v1';
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

function fragmentSimilarity(facts, a, b, rate, length) {
    const width = Math.min(Math.round(rate * .05), length - Math.max(a, b));
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

export function findLoopPhrase(audio, rate, beats, attacks, facts = signalFacts(audio, rate), downbeats = []) {
    const intervals = beats.slice(1).map((at, i) => at - beats[i]).filter(value => value >= rate * .15 && value <= rate * 2);
    const period = median(intervals);
    if (!period || intervals.length < 3) { return null; }
    const consistent = intervals.filter(value => Math.abs(value - period) <= period * .08).length / intervals.length;
    if (consistent < .7) { return null; }
    // Search inside the source, rather than assuming its first/last event is
    // the phrase boundary. Bound the search independently of dense raw onsets.
    const points = unique([facts.start, ...attacks.filter(at => at >= facts.start && at < facts.end), facts.end]);
    const candidates = [];
    const barEvidence = downbeats.length >= 2 && downbeats.slice(1).every((at,i) => Math.abs((at-downbeats[i])/period-4) <= .15);
    for (let i = 0; i < points.length && i < 512; i++) {
        for (let j = i + 1; j < points.length && j < 512; j++) {
            const start = points[i], end = points[j], pulses = Math.round((end - start) / period);
            if (pulses < 2 || Math.abs(end - start - pulses * period) > period * .04) { continue; }
            if (barEvidence && pulses % 4 !== 0) { continue; }
            const similarity = fragmentSimilarity(facts, start, end, rate, audio.length);
            const endIsFile = Math.abs(end - facts.end) <= rate * .002;
            const quietSeam = endIsFile && facts.power(Math.max(start, end - rate * .005), end) <
                Math.max(1e-10, facts.power(start, start + rate * .02) * .001);
            const barDistance = at => {
                const phase = ((at-downbeats[0])%(period*4)+period*4)%(period*4);
                return Math.min(phase,period*4-phase);
            };
            const alignedBar = barEvidence && barDistance(start) <= period*.08 && barDistance(end) <= period*.08;
            const seam = Math.abs(audio[start]-audio[Math.max(start,end-1)]) / Math.max(1e-9,facts.peak);
            if ((similarity < .92 && !quietSeam && !alignedBar) || seam > .05) { continue; }
            const covered = beats.filter(at => at >= start && at < end).length;
            if (Math.abs(covered - pulses) > 1) { continue; }
            candidates.push({start, end, period: (end - start) / pulses, observedPeriod: period, pulses,
                confidence: Math.min(consistent, quietSeam || alignedBar ? .95 : similarity), similarity});
        }
    }
    // Prefer complete, longer phrases among candidates with good seam evidence.
    candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start) || b.confidence - a.confidence || a.start - b.start);
    return candidates[0] || null;
}

export function assessPreparation(channels, rate, data, tags, evidence = {}) {
    const facts = signalFacts(channels[0], rate), attacks = validateAttacks(channels[0], rate, data.loop.transients || [], facts);
    const reasons = [];
    if (facts.silent) { reasons.push('silent-audio'); }
    if (!tags.length || tags.includes('unclassified') || evidence.mode === 'alternatives') { reasons.push('uncertain-category'); }
    if (tags.includes('synth') && !data.pitch.hasRoot) { reasons.push('uncertain-root'); }
    let bounds = {start: facts.start, end: facts.end}, phrase = null;
    if (tags.includes('loops')) {
        phrase = findLoopPhrase(channels[0], rate, data.loop.beats || [], unique([...attacks.accepted, ...(data.loop.transients || [])]), facts, data.loop.downbeats || []);
        if (!phrase) { reasons.push('uncertain-loop-phrase'); }
        else { bounds = {start: phrase.start, end: phrase.end}; }
    }
    if (attacks.rejected.some(at => at >= bounds.start && at < bounds.end)) { reasons.push('uncertain-attacks'); }
    return {version: 1, method: PREPARATION, reasons, bounds, phrase, attacks, silent: facts.silent};
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
        // These are checked, performed phrase bounds. Derive a closed grid only
        // after cropping; native readers also rebuild their grid from the beats.
        if (phrase && !['pitch','acousticPitch'].includes(name)) {
            if (manual) {
                item.beats = Array.from({length:phrase.pulses},(_,i)=>Math.round(i*samples/phrase.pulses));
                item.downbeats = item.beats.filter((_,i)=>i%4===0);
                item.beatDetector = 'manual-phrase-beat-count-v1';
            } else if (item.beats.length === phrase.pulses-1 && item.beats[0] > item.beatPeriod*.4) {
                item.beats.unshift(0);
            }
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

export async function publishWorkspace(folder, workspace) {
    workspace.publicationPolicy = PREPARATION;
    const entries = workspace.entries.filter(row => row.state === 'ready').map(row => row.output || row);
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

