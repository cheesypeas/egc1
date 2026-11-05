import {canonicalPath} from '../storage.js';
import {hashFile, hashBytes} from '../audio.js';

export const CATEGORIES = {drums: ['kick','snare','clap','hat','tom','cymbal','percussion'], loops: ['drum-loop','melodic-loop','vocal-loop'], synth: ['bass','lead','pad','keys'], vocal: ['vocal-note'], fx: []};
export const REASONS = new Set(['attack','tail','bleed','duplicate','not-drum','split','merged','leading-silence','trailing-silence','loop-gap','loop-click','loop-timing','wrong-category','wrong-role','wrong-root','too-short','silence','distorted']);
const TAGS = new Set([...Object.keys(CATEGORIES), ...Object.values(CATEGORIES).flat()]);
const ID = /^[sh]-[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const stamp = () => new Date().toISOString();
const clone = value => structuredClone(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const publicReview = row => row ? Object.fromEntries(['tags','certainty','quality','reasons','notes','boundaries','assisted','updatedAt'].map(key => [key,row[key]])) : null;
const digest = text => hashBytes(new TextEncoder().encode(text));
const token = (key, item) => item.attentionToken || `${key}:${item.revision || 0}`;
const empty = () => ({version: 1, revision: 0, reviews: {}, exposures: {}, history: []});

export class ReviewLibrary {
    constructor(folder, cache, progress = () => {}) {
        this.folder = folder; this.cache = cache; this.progress = progress;
        this.items = new Map(); this.verified = new Map(); this.skipped = 0;
    }
    async initialise() {
        await this.folder.initialise();
        this.manifest = await this.folder.json('.egc1/library.json');
        if (this.manifest?.version !== 1 || !Array.isArray(this.manifest.entries)) { throw new Error('This folder has no prepared library. Process it first, or select the folder containing .egc1 metadata.'); }
        this.items.clear(); this.skipped = 0;
        const rows = this.manifest.entries.filter(row => row.state === 'ready');
        for (const [index, row] of rows.entries()) {
            this.progress(`Opening prepared samples · ${index + 1} / ${rows.length}`);
            try {
                const item = await this.sample(row);
                if (!this.items.has(item.id)) { this.items.set(item.id, item); }
                const kit = await this.folder.json(`.egc1/kits/${row.id}/kit.json`);
                if (kit) { await this.hits(item, kit); }
            } catch (error) { this.skipped++; }
        }
        if (!this.items.size) { throw new Error('No complete, playable samples were found. Check the processing results.'); }
        this.fingerprint = await digest([...this.items.keys()].sort().join('\n'));
        const disk = await this.folder.json('.egc1/evaluation.json');
        const cached = await this.cache.get('reviews:' + this.fingerprint);
        this.data = disk || empty();
        if (cached && (!disk || cached.revision > disk.revision)) { this.data = cached; }
        this.validateStore(this.data);
        if (!this.folder.handle && (!disk || this.data.revision > disk.revision)) { await this.folder.writeJson('.egc1/evaluation.json',this.data); }
        this.feedback = await this.folder.json('.egc1/instrument-feedback.json') || {version: 1, revision: 0, items: {}};
        this.resolutions = await this.folder.json('.egc1/instrument-resolutions.json') || await this.cache.get('resolutions:' + this.fingerprint) || {version: 1, resolutions: {}};
        if (this.feedback.version !== 1 || !this.feedback.items || this.resolutions.version !== 1 || !this.resolutions.resolutions) { throw new Error('Instrument feedback is damaged. Restore it before reviewing.'); }
        if (!this.folder.handle && Object.keys(this.resolutions.resolutions || {}).length) { await this.folder.writeJson('.egc1/instrument-resolutions.json',this.resolutions); }
        return this;
    }
    validateStore(data) {
        if (data?.version !== 1 || !Number.isInteger(data.revision) || data.revision < 0 || !object(data.reviews) || !object(data.exposures) || !Array.isArray(data.history)) { throw new Error('Saved reviews are damaged or unsupported. They have not been overwritten.'); }
    }
    async sample(row) {
        if (!HASH.test(row.id) || ![1,2].includes(row.channels) || !Number.isInteger(row.samples) || row.samples <= 0 || row.samples >= row.rate * 60 || row.rate < 8000 || row.rate > 192000) { throw new Error('Invalid sample dimensions'); }
        const analysis = await this.folder.json(`.egc1/entries/${row.id}.json`);
        if (analysis?.version !== 1 || analysis.id !== row.id || ['pitch','loop','vocal'].some(role => analysis[role]?.samples !== row.samples || analysis[role]?.rate !== row.rate)) { throw new Error('Incomplete analysis'); }
        const file = await this.folder.file(row.path);
        if (!file) { throw new Error('Missing prepared audio'); }
        const p = row.provenance;
        let id = 's-' + row.id, start = 0, end = row.samples, sourceId = row.id, sourcePath = row.path, sourceFrames = row.samples;
        if (p) {
            if (p.kind !== 'separated' || !HASH.test(p.sourceId) || !Number.isInteger(p.start) || !Number.isInteger(p.end) || p.start < 0 || p.end <= p.start || p.end > p.sourceSamples || p.end - p.start !== row.samples || p.rate !== row.rate || !canonicalPath(row.path).startsWith(`.egc1/regions/${p.sourceId}/`) || canonicalPath(p.sourcePath).startsWith('.egc1/')) { throw new Error('Invalid source provenance'); }
            id = 's-' + await digest(`region-v1:${p.sourceId}:${p.start}:${p.end}:${row.id}`);
            start = p.start; end = p.end; sourceId = p.sourceId; sourcePath = p.sourcePath; sourceFrames = p.sourceSamples;
            if (!await this.folder.file(sourcePath)) { throw new Error('Missing original region source'); }
        } else if (canonicalPath(row.path).startsWith('.egc1/')) { throw new Error('Generated audio needs provenance'); }
        const semantic = await this.folder.json(`.egc1/semantic/${row.id}.json`);
        const useSemantic = semantic?.id === row.id && semantic.analysisPipeline === analysis.pipeline && !['manual','name','name+audio-model'].includes(row.tagsSource);
        return {id, kind: 'sample', origin: p ? 'separated' : 'source', provenance: p || null, archived: Boolean(row.archived), analysisId: row.id,
            mediaKey: row.id, sourceKey: sourceId, path: row.path, sourcePath, filename: sourcePath,
            rate: row.rate, channels: row.channels, startFrame: start, endFrame: end, startSeconds: start / row.rate, endSeconds: end / row.rate,
            sourceFrames, sourceDuration: sourceFrames / row.rate, duration: row.samples / row.rate,
            transients: (analysis.loop.transients || []).map(frame => frame + start), prediction: useSemantic ? semantic.tags : row.tags || [],
            policy: useSemantic ? semantic.policy : row.classification || this.manifest.classification || {}, roleEvidence: semantic?.roleEvidence || row.browserRoleEvidence || null};
    }
    async hits(parent, kit) {
        if (kit.version !== 1 || kit.sourceId !== parent.analysisId || kit.rate !== parent.rate || !Array.isArray(kit.hits)) { throw new Error('Invalid hit kit'); }
        for (const hit of kit.hits) {
            if (!Number.isInteger(hit.start) || !Number.isInteger(hit.end) || hit.start < 0 || hit.end <= hit.start || hit.end > parent.endFrame - parent.startFrame || typeof hit.file !== 'string' || hit.file.includes('/') || hit.file.includes('\\')) { throw new Error('Invalid kit cut'); }
            const path = `.egc1/kits/${parent.analysisId}/${hit.file}`, file = await this.folder.file(path);
            if (!file) { throw new Error('Missing kit hit'); }
            const hash = HASH.test(hit.id || '') ? hit.id : await hashFile(file);
            const parentKey = parent.origin === 'source' ? parent.analysisId : parent.id;
            const id = 'h-' + await digest(`${parentKey}:${hit.start}:${hit.end}:${hash}`);
            const semantic = await this.folder.json(`.egc1/semantic/${hash}.json`);
            const start = parent.startFrame + hit.start, end = parent.startFrame + hit.end;
            this.items.set(id, {...parent, id, kind: 'hit', origin: 'extracted', path, mediaKey: hash,
                provenance: {kind: 'extracted', method: 'transient-kit-v1', parentId: parent.id, parentProvenance: parent.provenance},
                startFrame: start, endFrame: end, startSeconds: start / parent.rate, endSeconds: end / parent.rate,
                duration: (end - start) / parent.rate, prediction: semantic?.tags || hit.browserTags || [], policy: semantic?.policy || {method: 'unassigned-extracted-hit'}, roleEvidence: semantic?.roleEvidence || null});
        }
    }
    flags(id) {
        const result = {favourite: false, needsAttention: false, known: false, groups: []};
        for (const [key, row] of Object.entries(this.feedback.items)) {
            if (key !== id && !row.members?.includes(id)) { continue; }
            result.known = true; result.favourite ||= Boolean(row.favourite);
            if (row.needsAttention && this.resolutions.resolutions[token(key, row)]?.id !== key) { result.needsAttention = true; result.groups.push({id: key, revision: row.revision || 0}); }
        }
        return result;
    }
    item(id) { const item = this.items.get(id); if (!item || !ID.test(id)) { throw new Error('Unknown review item'); } return item; }
    session() {
        // Alternate source folders within each kind without exposing filenames or predictions.
        const ordered = [];
        for (const kind of ['sample','hit']) {
            const groups = new Map();
            for (const item of [...this.items.values()].filter(item => item.kind === kind).sort((a,b) => a.id.localeCompare(b.id))) {
                const group = item.sourcePath.split('/').slice(0,-1).join('/');
                if (!groups.has(group)) { groups.set(group,[]); }
                groups.get(group).push(item);
            }
            while ([...groups.values()].some(group => group.length)) {
                for (const group of groups.values()) { if (group.length) { ordered.push(group.shift()); } }
            }
        }
        const fields = ['id','kind','duration','sourceDuration','channels','startSeconds','endSeconds','rate','startFrame','endFrame','sourceFrames','transients','origin','sourceKey','mediaKey','archived'];
        const items = ordered.map(item => ({...Object.fromEntries(fields.map(key => [key,item[key]])), instrument:this.flags(item.id),review:publicReview(this.data.reviews[item.id]),exposed:Object.hasOwn(this.data.exposures,item.id)}));
        return {items, fingerprint: this.fingerprint, taxonomy: CATEGORIES, canUndo: Boolean(this.data.history.length), token: '', fileCount: this.manifest.sourceFiles || this.manifest.entries.length,
            packCount: new Set([...this.items.values()].map(item => item.sourcePath.split('/').slice(0,-1).join('/'))).size, skipped: this.skipped, flagged: this.manifest.entries.filter(row => row.state === 'failed').length, queuePolicy: 'egc1-review-v1',
            processing: this.manifest.state === 'processing', classifier: this.manifest.classification || {}, previousComparison: this.comparison(this.data.lastComparison)};
    }
    comparison(id) {
        const row = this.data.reviews[id]; if (!row) { return null; }
        const item = this.items.get(id);
        return {id, tags: row.tags, prediction: row.prediction || [], predictionMethod: row.predictionPolicy?.method, reviewedAt: row.updatedAt,
            assisted: row.assisted, kind: row.kind, rating: row.comparison?.rating, mediaKey: item?.mediaKey, available: Boolean(item)};
    }
    async commit(change) {
        const execute = async () => {
            const disk = await this.folder.json('.egc1/evaluation.json');
            const cached = await this.cache.get('reviews:' + this.fingerprint);
            for (const current of [disk,cached]) {
                if (current) { this.validateStore(current); if (current.revision > this.data.revision) { this.data = clone(current); } }
            }
            const before = clone(this.data);
            let result;
            try {
                result = change(); this.data.revision++;
                await this.folder.writeJson('.egc1/evaluation.json',this.data);
            } catch (error) { this.data = before; throw error; }
            // A committed folder write remains authoritative if optional browser storage fails.
            try { await this.cache.set('reviews:' + this.fingerprint,this.data); }
            catch (error) { this.progress('Review saved to metadata. Browser backup is unavailable; download metadata before closing in download mode.'); }
            return result;
        };
        return globalThis.navigator?.locks ? navigator.locks.request('egc1-review:' + this.fingerprint,execute) : execute();
    }
    validate(payload, item) {
        if (!object(payload) || !Array.isArray(payload.tags) || payload.tags.some(tag => !TAGS.has(tag))) { throw new Error('Unknown category or role'); }
        for (const [category, roles] of Object.entries(CATEGORIES)) { if (roles.some(role => payload.tags.includes(role)) && !payload.tags.includes(category)) { throw new Error('A role needs its parent category'); } }
        if (!['clear','tentative','unsure'].includes(payload.certainty) || ![null,'keep','reject','unsure'].includes(payload.quality)) { throw new Error('Choose a valid certainty and grouping assessment'); }
        if (item.kind === 'sample' && !payload.tags.length && payload.certainty !== 'unsure') { throw new Error('Choose a category or mark this sample unsure'); }
        if ((item.kind === 'hit' || item.origin === 'separated') && payload.quality === null) { throw new Error('Rate the extraction or separation before saving'); }
        if (!Array.isArray(payload.reasons) || payload.reasons.some(reason => !REASONS.has(reason)) || typeof payload.notes !== 'string' || payload.notes.length > 2000) { throw new Error('Invalid issue choices or notes'); }
        const b = payload.boundaries;
        if (!b || Object.keys(b).some(key => !['attackFrame','endFrame'].includes(key)) || Object.values(b).some(frame => frame !== null && (!Number.isInteger(frame) || frame < 0 || frame > item.sourceFrames)) || (b.attackFrame != null && b.endFrame != null && b.attackFrame >= b.endFrame)) { throw new Error('Invalid source-frame boundaries'); }
    }
    async save(id, payload) {
        const item = this.item(id); this.validate(payload,item);
        return this.commit(() => {
            const candidate = item.kind === 'hit' || item.origin === 'separated' ? item.startFrame : item.transients[0] || 0;
            const boundaries = {...payload.boundaries, method: 'visual-cut-review', attackCandidateFrame: candidate, endCandidateFrame: item.endFrame};
            for (const [name, proposed] of [['attack',candidate],['end',item.endFrame]]) {
                const frame = boundaries[name + 'Frame'];
                if (frame != null) { boundaries[name + 'OffsetFrames'] = frame - proposed; boundaries[name + 'OffsetMs'] = (frame - proposed) * 1000 / item.rate; }
            }
            this.data.history.push({id, previous: clone(this.data.reviews[id] || null)}); this.data.history = this.data.history.slice(-100);
            const flags = this.flags(id);
            this.data.reviews[id] = {tags: [...new Set(payload.tags)].sort(), certainty: payload.certainty, quality: payload.quality, reasons: [...new Set(payload.reasons)].sort(), notes: payload.notes,
                boundaries, updatedAt: stamp(), assisted: Boolean(this.data.exposures[id] || flags.known), instrumentFeedback: flags,
                kind: item.kind, sourceId: item.sourceKey, start: item.startFrame, end: item.endFrame, rate: item.rate, origin: item.origin,
                analysisId: item.analysisId, provenance: clone(item.provenance), prediction: clone(item.prediction), predictionPolicy: clone(item.policy)};
            this.data.exposures[id] ||= stamp(); this.data.lastComparison = id;
            return {saved: true, comparison: this.comparison(id)};
        });
    }
    async request(path, value) {
        if (path.startsWith('/api/session')) { if (path.includes('refresh=1')) { await this.initialise(); } return this.session(); }
        if (path === '/api/export') { return this.export(); }
        const id = path.split('/').pop();
        if (path.startsWith('/api/review/')) { return this.save(id,value); }
        if (path.startsWith('/api/reveal/')) {
            const item = this.item(id);
            await this.commit(() => { this.data.exposures[id] ||= stamp(); });
            return {filename: item.filename, prediction: item.prediction, policy: item.policy, roleEvidence: item.roleEvidence, origin: item.origin, provenance: item.provenance, start: item.startSeconds, end: item.endSeconds};
        }
        if (path.startsWith('/api/comparison/')) {
            const item = this.item(id);
            return this.commit(() => {
                const row = this.data.reviews[item.id];
                if (!row || value.reviewedAt !== row.updatedAt || !['way-off','close','pipeline-better'].includes(value.rating)) { throw new Error('This review changed. Refresh before comparing.'); }
                row.comparison = {rating: value.rating, updatedAt: stamp(), judgementUpdatedAt: row.updatedAt};
                this.data.exposures[id] ||= stamp(); return this.comparison(id);
            });
        }
        if (path === '/api/undo') {
            return this.commit(() => {
                const action = this.data.history.pop(); if (!action) { return {id:null}; }
                if (action.previous) { this.data.reviews[action.id] = action.previous; } else { delete this.data.reviews[action.id]; }
                this.data.lastComparison = this.data.reviews[action.id] ? action.id : this.data.history.at(-1)?.id;
                return {id: action.id};
            });
        }
        if (path.startsWith('/api/resolve-instrument/')) {
            const item = this.item(id);
            const execute = async () => {
                const fresh = await this.folder.json('.egc1/instrument-feedback.json') || this.feedback;
                if (!Array.isArray(value?.groups) || !value.groups.length) { throw new Error('No current attention flag'); }
                const resolved = clone(await this.folder.json('.egc1/instrument-resolutions.json') || await this.cache.get('resolutions:' + this.fingerprint) || this.resolutions);
                for (const group of value.groups) {
                    const row = fresh.items[group?.id];
                    if (!row || (row.revision || 0) !== group.revision || (group.id !== id && !row.members?.includes(id))) { throw new Error('Instrument flag changed. Refresh before resolving.'); }
                    resolved.resolutions[token(group.id,row)] = {id:group.id,resolvedAt:stamp()};
                }
                await this.folder.writeJson('.egc1/instrument-resolutions.json',resolved);
                this.resolutions = resolved; this.feedback = fresh;
                await this.cache.set('resolutions:' + this.fingerprint,resolved);
                return {resolved:true};
            };
            return globalThis.navigator?.locks ? navigator.locks.request('egc1-review:' + this.fingerprint,execute) : execute();
        }
        throw new Error('Unknown review operation');
    }
    export() {
        const reviews = Object.fromEntries(Object.entries(this.data.reviews).filter(([id]) => this.items.has(id)));
        return {version:1, exportedAt:stamp(), datasetFingerprint:this.fingerprint, taxonomy:CATEGORIES, reviews,
            summary:{reviewed:Object.keys(reviews).length, blind:Object.values(reviews).filter(row => !row.assisted).length, unsure:Object.values(reviews).filter(row => row.certainty === 'unsure').length,
                comparisons:Object.fromEntries(['way-off','close','pipeline-better'].map(rating => [rating,Object.values(reviews).filter(row => row.comparison?.rating === rating).length]))}};
    }
    async audio(path) {
        const id = path.split('/').pop(), item = this.item(id), source = path.startsWith('/api/source/');
        const relative = source ? item.sourcePath : item.path, expected = source ? item.sourceKey : item.mediaKey;
        const file = await this.folder.file(relative);
        if (!file) { throw new Error('Audio file is missing. Select the complete library folder.'); }
        const signature = `${file.size}:${file.lastModified}`;
        if (this.verified.get(relative) !== signature) {
            if (await hashFile(file) !== expected) { throw new Error('Audio changed since processing. Reprocess this file before reviewing it.'); }
            this.verified.set(relative,signature);
        }
        return new Response(file);
    }
    async importReviews(value) {
        if (value?.version !== 1 || !object(value.reviews)) { throw new Error('Unsupported review export'); }
        const accepted = Object.entries(value.reviews).filter(([id]) => this.items.has(id));
        for (const [id,row] of accepted) { if (!object(row) || typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt))) { throw new Error('Invalid review record'); } this.validate({...row,boundaries:Object.fromEntries(['attackFrame','endFrame'].map(key => [key,row.boundaries?.[key] ?? null]))},this.item(id)); }
        await this.commit(() => {
            for (const [id,row] of accepted) {
                const current = this.data.reviews[id];
                if (!current || row.updatedAt > current.updatedAt) { this.data.reviews[id] = clone(row); }
                if (row.assisted) { this.data.exposures[id] ||= row.updatedAt || stamp(); }
            }
        });
        return accepted.length;
    }
}
