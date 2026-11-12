// Label policy ported from ToySampler semantic_classifier.py, rules version 3.
export const FAMILIES = {
    drums: ['kick', 'snare', 'clap', 'hat', 'tom', 'cymbal', 'percussion', 'drum-loop'],
    synth: ['bass', 'lead', 'pad', 'keys', 'instrument', 'melodic-loop'],
    vocal: ['speech', 'vocal-note', 'vocal-loop'], fx: ['fx', 'ambience'],
};
export const HINT_METHOD = 'nearest-name-hints-v3';
const best = (keys, scores) => keys.reduce((a, b) => scores[b] > scores[a] ? b : a);
const descending = (a, b) => b[0] - a[0] || (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0);

export function classifyScores(scores, seconds, loop = {}, kind = 'sample', silent = false) {
    const expected = [...Object.values(FAMILIES).flat(), 'silence'];
    if (Object.keys(scores).length !== expected.length || expected.some(k => !Number.isFinite(scores[k]) || Math.abs(scores[k]) > 1.0001)) {
        throw new Error('Incomplete or invalid model scores.');
    }
    if (silent) { return {tags: ['unclassified'], reason: 'silent-audio'}; }
    const ranked = Object.entries(FAMILIES).map(([name, roles]) => [scores[best(roles, scores)], name]).sort(descending);
    const [confidence, family] = ranked[0];
    const points = loop.transients || [], rate = loop.rate || 1;
    const span = points.length > 1 && rate > 0 ? (points[points.length - 1] - points[0]) / rate : 0;
    const sequence = kind === 'sample' && seconds >= 1 && points.length >= 4 && span >= seconds * .45;
    const grid = sequence && (loop.beatConfidence || 0) >= .75 && (loop.beats || []).length >= 4;
    const ambiguous = {tags: ['unclassified'], reason: 'low-similarity-or-ambiguous-family'};
    if (scores.silence >= confidence || confidence < .18) { return ambiguous; }
    if (confidence - ranked[1][0] < .015) {
        const loopRoles = ['drum-loop', 'melodic-loop', 'vocal-loop'];
        const competing = ranked.filter(([score]) => confidence - score < .015).map(([, name]) => best(FAMILIES[name], scores));
        const other = Math.max(...Object.entries(scores).filter(([key]) => !loopRoles.includes(key)).map(([, value]) => value));
        if (grid && competing.every(role => loopRoles.includes(role)) && confidence - other >= .015 && confidence - scores.speech >= .06) {
            return {tags: ['loops'], reason: 'shared-loop-destination-uncertain-role'};
        }
        return ambiguous;
    }
    const leaf = best(FAMILIES[family], scores), tags = [family];
    if (family === 'drums') {
        const hits = FAMILIES.drums.slice(0, -1), top = best(hits, scores);
        if (sequence && (leaf === 'drum-loop' || grid)) { return {tags: ['loops', 'drum-loop'], reason: 'drum-timbre-and-original-event-sequence'}; }
        if (scores[top] >= .22) {
            const candidates = hits.filter(k => scores[k] >= scores[top] - .02 && scores[k] >= .22);
            if (candidates.length === 1) { tags.push(candidates[0]); }
        }
    } else if (family === 'synth') {
        if (sequence && leaf === 'melodic-loop') { return {tags: ['loops', 'melodic-loop'], reason: 'instrumental-phrase-and-original-event-sequence'}; }
        const roles = ['bass', 'lead', 'pad', 'keys'].map(k => [scores[k], k]).sort(descending);
        if (['bass', 'lead', 'pad', 'keys'].includes(leaf) && roles[0][0] >= .22 && roles[0][0] - roles[1][0] >= .015) { tags.push(roles[0][1]); }
    } else if (family === 'vocal') {
        if (grid && seconds >= 4 && leaf === 'vocal-loop' && scores[leaf] >= .35 && scores[leaf] - scores.speech >= .06) {
            return {tags: ['loops', 'vocal-loop'], reason: 'vocal-phrase-and-strong-original-grid'};
        }
        if (leaf === 'vocal-note' && seconds <= 4) { tags.push('vocal-note'); }
    }
    return {tags, reason: 'semantic-timbre'};
}

export function roleEvidence(tags, scores) {
    if (tags.includes('drums')) {
        const assigned = tags.filter(tag=>[...FAMILIES.drums.slice(0,-1),'fx'].includes(tag));
        if(assigned.length) { return {mode:assigned.length===1 ? 'single' : 'alternatives',candidates:assigned,assigned:assigned.length===1 ? assigned[0] : null}; }
        const hits = FAMILIES.drums.slice(0, -1), top = Math.max(...hits.map(k => scores[k]));
        const candidates = hits.filter(k => scores[k] >= .22 && scores[k] >= top - .02);
        return {mode: candidates.length > 1 ? 'alternatives' : candidates.length ? 'single' : 'unassigned', candidates, assigned: candidates.length === 1 ? candidates[0] : null};
    }
    const candidates = tags.filter(k => !(k in FAMILIES) && !['loops', 'unclassified', 'recorded'].includes(k));
    return {mode: candidates.length === 1 ? 'single' : 'unassigned', candidates, assigned: candidates.length === 1 ? candidates[0] : null};
}

export function nameHints(path) {
    // A pack title or broad ancestor (e.g. Bass Boutique/Sounds And Fx) must
    // not add categories to a clearly named hit. Prefer the filename, then
    // the nearest informative directory, rather than unioning the whole path.
    const parts = path.replaceAll('\\','/').split('/').filter(Boolean).reverse().map(componentHints);
    const recorded = parts.some(tags=>tags.includes('recorded'));
    for(const tags of parts) {
        const substantive = tags.filter(tag=>tag!=='recorded');
        if(substantive.length) {
            return [...substantive,...(recorded ? ['recorded'] : [])];
        }
    }
    return recorded ? ['recorded'] : [];
}

function componentHints(name) {
    const tokens = name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const has = words => tokens.some(token => words.some(word => token === word || (token.startsWith(word) && /^\d+$/.test(token.slice(word.length)))));
    const loop = has(['loop', 'loops', 'break', 'breaks', 'breakbeat', 'breakbeats']);
    const vocal = has(['vocal', 'vocals', 'voice', 'voices', 'speech', 'spoken', 'acapella', 'acappella']);
    const drum = has(['drum', 'drums', 'kit', 'kits', 'kick', 'kicks', 'bd', 'snare', 'snares', 'sd', 'clap', 'claps', 'hat', 'hats', 'hihat', 'hh', 'ohh', 'chh', 'cymbal', 'cymbals', 'crash', 'ride', 'tom', 'toms', 'percussion', 'perc']);
    const synth = has(['synth', 'synths', 'bass', 'sub', 'subs', 'subbass', 'lead', 'leads', 'pad', 'pads', 'keys', 'piano']);
    const tags = [];
    if (loop) {
        tags.push('loops');
        if (drum || has(['break', 'breaks', 'breakbeat', 'breakbeats'])) { tags.push('drum-loop'); }
        if (synth) { tags.push('melodic-loop'); }
        if (vocal) { tags.push('vocal-loop'); }
    }
    if (drum && !loop) {
        tags.push('drums');
        const aliases = {kick: ['kicks', 'bd'], snare: ['snares', 'sd'], clap: ['claps'], hat: ['hats', 'hihat', 'hh', 'ohh', 'chh'], cymbal: ['cymbals', 'crash', 'ride'], tom: ['toms'], percussion: ['perc']};
        for (const role of FAMILIES.drums.slice(0, -1)) { if (has([role, ...(aliases[role] || [])])) { tags.push(role); } }
    }
    if (synth && !loop) {
        tags.push('synth');
        if (has(['bass', 'sub', 'subs', 'subbass'])) { tags.push('bass'); }
        if (has(['lead', 'leads'])) { tags.push('lead'); }
        if (has(['pad', 'pads'])) { tags.push('pad'); }
        if (has(['keys', 'piano'])) { tags.push('keys'); }
    }
    if (vocal) { tags.push('vocal'); }
    if (has(['fx', 'sfx', 'effect', 'effects'])) { tags.push('drums', 'fx'); }
    if (has(['recorded', 'recordings'])) { tags.push('recorded'); }
    return [...new Set(tags)];
}

export function applyHints(audioTags, hints) {
    const result = [...hints];
    const groups = [['drums', ...FAMILIES.drums.slice(0, -1), 'fx'], ['synth', 'bass', 'lead', 'pad', 'keys'],
        ['loops', 'drum-loop', 'melodic-loop', 'vocal-loop'], ['vocal', 'vocal-note']];
    for (const [family, ...roles] of groups) {
        if (result.includes(family) && audioTags.includes(family) && !roles.some(r => result.includes(r))) {
            result.push(...roles.filter(r => audioTags.includes(r)));
        }
    }
    if (result.includes('loops') && !['drum-loop', 'melodic-loop', 'vocal-loop'].some(r => result.includes(r))) {
        if (audioTags.includes('drums')) { result.push('drum-loop'); }
        if (audioTags.includes('synth')) { result.push('melodic-loop'); }
        if (audioTags.includes('vocal')) { result.push('vocal-loop'); }
    }
    return [...new Set(result)];
}

export function destination(tags) {
    if (tags.includes('loops')) { return 'Loops'; }
    if (tags.includes('synth')) { return 'Synth'; }
    if (tags.includes('vocal')) { return 'Voice'; }
    if (tags.includes('fx')) { return 'FX'; }
    if (tags.includes('drums')) { return 'Drums'; }
    return 'Unclassified';
}

export const BANKS = {version: 1, banks: [
    [{label: 'Hits', kind: 'samples', tagsAny: ['drums'], exclude: ['percussion', 'recorded']},
     {label: 'Extracted kits', kind: 'kits'}, {label: 'Percussion', kind: 'samples', tagsAny: ['percussion'], exclude: ['recorded']},
     {label: 'Recorded', kind: 'samples', tagsAll: ['drums', 'recorded']}],
    [{label: 'Drum loops', kind: 'samples', tagsAll: ['loops', 'drum-loop'], exclude: ['recorded']},
     {label: 'Melodic loops', kind: 'samples', tagsAll: ['loops', 'melodic-loop'], exclude: ['recorded']},
     {label: 'Vocal phrases', kind: 'samples', tagsAny: ['vocal', 'vocal-loop'], exclude: ['vocal-note', 'recorded']},
     {label: 'Recorded', kind: 'samples', tagsAny: ['loops', 'vocal'], tagsAll: ['recorded'], exclude: ['vocal-note']}],
    [{label: 'Bass', kind: 'samples', tagsAll: ['synth', 'bass'], exclude: ['recorded']},
     {label: 'Lead / keys / short vocals', kind: 'samples', tagsAny: ['lead', 'keys', 'vocal-note'], includeUnroledSynth: true, exclude: ['recorded']},
     {label: 'Pads', kind: 'samples', tagsAll: ['synth', 'pad'], exclude: ['recorded']},
     {label: 'Recorded', kind: 'samples', tagsAny: ['synth', 'vocal-note'], tagsAll: ['recorded']}],
]};

// Count unique prepared audio, using the same tag predicates as the instrument.
// A sound can belong to several banks; duplicate file placements count once.
export function bankSummary(config, rows, kits = new Map()) {
    const samples = new Map();
    for (const row of rows) {
        if (row.state === 'ready') { samples.set(row.id, row); }
    }
    const assigned = new Set();
    const banks = config.banks.map((group, mode) => group.map((bank, slot) => {
        let sounds = 0, collections = 0;
        for (const [id, row] of samples) {
            if (bank.kind === 'kits') {
                if (kits.get(id)) { collections++; sounds += kits.get(id); assigned.add(id); }
                continue;
            }
            const tags = row.tags || [];
            const unroled = bank.includeUnroledSynth && tags.includes('synth') &&
                !['bass', 'pad', 'lead', 'keys'].some(tag => tags.includes(tag));
            if ((bank.tagsAny?.length && !bank.tagsAny.some(tag => tags.includes(tag)) && !unroled) ||
                !(bank.tagsAll || []).every(tag => tags.includes(tag)) ||
                (bank.exclude || []).some(tag => tags.includes(tag))) { continue; }
            sounds++; assigned.add(id);
        }
        return {mode, slot, label: bank.label, kind: bank.kind, sounds, ...(bank.kind === 'kits' ? {kits: collections} : {})};
    }));
    return {banks, uniqueSamples: samples.size, unassigned: samples.size - assigned.size};
}
