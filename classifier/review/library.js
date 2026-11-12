import {canonicalPath} from '../storage.js';
import {hashFile, hashBytes, audioInfo, readWav} from '../audio.js';
import {readWorkspace, publishWorkspace, playableOutput, PREPARATION, signalFacts, reviewIdentity} from '../preparation.js';

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
    constructor(folder, cache, progress = () => {}, options = {}) {
        this.folder = folder; this.cache = cache; this.progress = progress;
        this.options = options;
        this.items = new Map(); this.verified = new Map(); this.skipped = 0;
    }
    async initialise() {
        await this.folder.initialise();
        this.manifest = await this.folder.json('.egc1/library.json');
        if (this.manifest?.version !== 1 || !Array.isArray(this.manifest.entries)) { throw new Error('This folder has no prepared library. Process it first, or select the folder containing .egc1 metadata.'); }
        this.items.clear(); this.skipped = 0;
        this.workspace = await readWorkspace(this.folder);
        const rows = this.workspace.entries.filter(row => ['ready', 'needs-review', 'rejected'].includes(row.state));
        for (const [index, row] of rows.entries()) {
            this.progress(`Opening prepared samples · ${index + 1} / ${rows.length}`);
            try {
                const item = await this.sample(row);
                if (!this.items.has(item.id)) { this.items.set(item.id, item); }
                const output = row.output || row;
                const kit = await this.folder.json(`.egc1/kits/${output.id}/kit.json`);
                if (kit) { await this.hits(item, kit, output); }
            } catch (error) { this.skipped++; }
        }
        if (!this.items.size) { throw new Error('No reviewable samples were found. Check the processing results.'); }
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
        for (const item of this.items.values()) {
            const review = this.data.reviews[item.id];
            const disputed = review && (review.quality === 'reject' || review.certainty !== 'clear' || review.reasons?.length) && item.admission?.reviewedAt !== review.updatedAt;
            if (item.publication === 'ready' && (this.flags(item.id).needsAttention || disputed)) {
                await this.publication(()=>this.withholdItem(item,this.flags(item.id).needsAttention ? 'instrument-attention' : 'human-review'));
            }
        }
        if (!this.folder.handle && Object.keys(this.resolutions.resolutions || {}).length) { await this.folder.writeJson('.egc1/instrument-resolutions.json',this.resolutions); }
        return this;
    }
    validateStore(data) {
        if (data?.version !== 1 || !Number.isInteger(data.revision) || data.revision < 0 || !object(data.reviews) || !object(data.exposures) || !Array.isArray(data.history)) { throw new Error('Saved reviews are damaged or unsupported. They have not been overwritten.'); }
    }
    async sample(row) {
        if (!HASH.test(row.id) || ![1,2].includes(row.channels) || !Number.isInteger(row.samples) || row.samples <= 0 || (row.state === 'ready' && row.samples >= row.rate * 60) || row.rate < 8000 || row.rate > 192000) { throw new Error('Invalid sample dimensions'); }
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
        if (row.reviewId) { if (!ID.test(row.reviewId)) { throw new Error('Invalid retained review identity'); } id = row.reviewId; }
        const semantic = await this.folder.json(`.egc1/semantic/${row.id}.json`);
        const useSemantic = semantic?.id === row.id && semantic.analysisPipeline === analysis.pipeline && !['manual','name','name+audio-model'].includes(row.tagsSource);
        return {id, kind: row.browserKind === 'hit' ? 'hit' : 'sample', origin: p ? 'separated' : 'source', provenance: p || null, archived: Boolean(row.archived), analysisId: row.id,
            mediaKey: row.id, sourceKey: sourceId, path: row.path, sourcePath, filename: sourcePath,
            rate: row.rate, channels: row.channels, startFrame: start, endFrame: end, startSeconds: start / row.rate, endSeconds: end / row.rate,
            sourceFrames, sourceDuration: sourceFrames / row.rate, duration: row.samples / row.rate,
            transients: (analysis.loop.transients || []).map(frame => frame + start), prediction: useSemantic ? semantic.tags : row.tags || [],
            policy: useSemantic ? semantic.policy : row.classification || this.manifest.classification || {}, roleEvidence: semantic?.roleEvidence || row.browserRoleEvidence || null,
            publication: row.state === 'ready' && !this.manifest.entries.some(entry => entry.state === 'ready' && entry.id === (row.output?.id || row.id)) ? 'needs-review' : row.state,
            preparation: row.preparation || null, admission: row.admission || null,
            kitParentId:row.kitParentId || null,kitHitFile:row.kitHitFile || null,
            reviewAliases:row.output ? [await reviewIdentity({...row.output,reviewId:null})] : []};
    }
    async hits(parent, kit, output) {
        if (kit.version !== 1 || kit.sourceId !== output.id || kit.rate !== parent.rate || !Array.isArray(kit.hits)) { throw new Error('Invalid hit kit'); }
        for (const hit of kit.hits) {
            if (!Number.isInteger(hit.start) || !Number.isInteger(hit.end) || hit.start < 0 || hit.end <= hit.start || hit.end > output.samples || typeof hit.file !== 'string' || hit.file.includes('/') || hit.file.includes('\\')) { throw new Error('Invalid kit cut'); }
            const path = `.egc1/kits/${output.id}/${hit.file}`, file = await this.folder.file(path);
            if (!file) { throw new Error('Missing kit hit'); }
            const hash = HASH.test(hit.id || '') ? hit.id : await hashFile(file);
            const parentKey = output.provenance ? await reviewIdentity({...output,reviewId:null}) : output.id;
            const id = 'h-' + await digest(`${parentKey}:${hit.start}:${hit.end}:${hash}`);
            const semantic = await this.folder.json(`.egc1/semantic/${hash}.json`);
            const offset = output.provenance?.start || 0;
            const start = offset + hit.start, end = offset + hit.end;
            if (this.workspace.entries.some(row=>row.kitParentId===output.id && row.id===hash && row.reviewId)) { continue; }
            this.items.set(id, {...parent, id, kind: 'hit', origin: 'extracted', path, mediaKey: hash, analysisId:hash,
                reviewAliases:[],kitParentId:output.id,kitHitFile:hit.file,channels:output.channels,
                provenance: {kind: 'extracted', method: 'transient-kit-v1', parentId: parent.id, parentProvenance: parent.provenance},
                startFrame: start, endFrame: end, startSeconds: start / parent.rate, endSeconds: end / parent.rate,
                duration: (end - start) / parent.rate, prediction: semantic?.tags || hit.browserTags || [], policy: semantic?.policy || {method: 'unassigned-extracted-hit'}, roleEvidence: semantic?.roleEvidence || null});
        }
    }
    flags(id) {
        const result = {favourite: false, needsAttention: false, known: false, groups: []};
        const aliases = [id,...(this.items.get(id)?.reviewAliases || [])];
        for (const [key, row] of Object.entries(this.feedback.items)) {
            if (!aliases.includes(key) && !aliases.some(alias=>row.members?.includes(alias))) { continue; }
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
        const fields = ['id','kind','duration','sourceDuration','channels','startSeconds','endSeconds','rate','startFrame','endFrame','sourceFrames','transients','origin','sourceKey','mediaKey','archived','publication','preparation','admission'];
        const items = ordered.map(item => ({...Object.fromEntries(fields.map(key => [key,item[key]])), instrument:this.flags(item.id),review:publicReview(this.data.reviews[item.id]),exposed:Object.hasOwn(this.data.exposures,item.id)}));
        return {items, fingerprint: this.fingerprint, taxonomy: CATEGORIES, canUndo: Boolean(this.data.history.length), token: '', fileCount: this.manifest.sourceFiles || this.manifest.entries.length,
            packCount: new Set([...this.items.values()].map(item => item.sourcePath.split('/').slice(0,-1).join('/'))).size, skipped: this.skipped, flagged: this.manifest.entries.filter(row => row.state === 'failed').length, queuePolicy: 'egc1-review-v1',
            processing: this.manifest.state === 'processing', classifier: this.manifest.classification || {}, previousComparison: this.comparison(this.data.lastComparison),
            publicationSupported: true};
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
        return this.publication(async () => {
            if (payload.certainty !== 'clear' || payload.quality === 'reject' || payload.quality === 'unsure' || payload.reasons.length ||
                payload.boundaries.attackFrame != null || payload.boundaries.endFrame != null ||
                [...payload.tags].sort().join() !== [...item.prediction].sort().join()) {
                await this.withholdItem(item, 'human-review');
            }
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
        });
    }
    async publication(change) {
        return globalThis.navigator?.locks ? navigator.locks.request('egc-classifier-write', {ifAvailable:true}, lock => {
            if (!lock) { throw new Error('Pause sample processing in other tabs before changing publication'); }
            return change();
        }) : change();
    }
    async withholdItem(item, reason, rejected = false) {
        const workspace = await readWorkspace(this.folder);
        let row = workspace.entries.find(row => row.id === item.analysisId && canonicalPath(row.path) === canonicalPath(item.path));
        if (!row && item.kind === 'hit' && item.kitParentId) {
            const path = `.egc1/kits/${item.kitParentId}/kit.json`, kit = await this.folder.json(path);
            if (!kit) { throw new Error('Kit changed; refresh before saving'); }
            // Remove the disputed hit from the instrument kit before any
            // further write; retain its audio as a separately reviewable item.
            kit.hits = kit.hits.filter(hit=>hit.file !== item.kitHitFile);
            await this.folder.writeJson(path,kit);
            const file = await this.folder.file(item.path);
            if (!file) { throw new Error('Kit audio is missing'); }
            const candidate = `.egc1/regions/${item.sourceKey}/${item.startFrame}-${item.endFrame}-${item.mediaKey}.wav`;
            await this.folder.write(candidate,file);
            row = {id:item.mediaKey,path:candidate,reviewId:item.id,state:'needs-review',browserKind:'hit',kitParentId:item.kitParentId,kitHitFile:item.kitHitFile,
                bytes:file.size,samples:item.endFrame-item.startFrame,rate:item.rate,channels:item.channels,tags:item.prediction,
                provenance:{kind:'separated',sourceId:item.sourceKey,sourcePath:item.sourcePath,sourceSamples:item.sourceFrames,rate:item.rate,start:item.startFrame,end:item.endFrame}};
            if (!await this.folder.json(`.egc1/entries/${row.id}.json`)) {
                const role = {samples:row.samples,rate:row.rate,transients:[],beats:[],downbeats:[]};
                await this.folder.writeJson(`.egc1/entries/${row.id}.json`,{version:1,id:row.id,pipeline:'kit-review',pitch:role,loop:role,vocal:role});
            }
            workspace.entries.push(row);
            item.path = candidate; item.origin = 'separated';
        }
        if (!row) { throw new Error('Candidate changed; refresh before changing publication'); }
        row.state = rejected ? 'rejected' : 'needs-review';
        row.preparation = {...row.preparation,method:PREPARATION, reasons: [...new Set([...(row.preparation?.reasons || []), reason])]};
        delete row.admission;
        await publishWorkspace(this.folder, workspace);
        item.publication = row.state; item.preparation = row.preparation; item.admission = null;
        this.workspace = workspace;
    }
    async admit(id, value, rejected = false) {
        return this.publication(async () => {
            const item = this.item(id);
            // Read the current durable judgement under the publication lock.
            const disk = await this.folder.json('.egc1/evaluation.json');
            const review = disk?.reviews?.[id];
            if (!review || review.updatedAt !== value?.reviewedAt) { throw new Error('Save the judgement, then approve that saved revision'); }
            this.validate({...review,boundaries:{attackFrame:review.boundaries?.attackFrame ?? null,endFrame:review.boundaries?.endFrame ?? null}},item);
            if (!rejected && (review.certainty !== 'clear' || !review.tags?.length)) { throw new Error('Choose clear categories before approval'); }
            let workspace = await readWorkspace(this.folder);
            let row = workspace.entries.find(row => row.id === item.analysisId && canonicalPath(row.path) === canonicalPath(item.path));
            if (!row && item.kind === 'hit') {
                await this.withholdItem(item,'manual-kit-correction');
                workspace = await readWorkspace(this.folder);
                row = workspace.entries.find(row=>row.reviewId === id);
            }
            if (!row) { throw new Error('Candidate changed; refresh before approval'); }
            this.feedback = await this.folder.json('.egc1/instrument-feedback.json') || this.feedback;
            this.resolutions = await this.folder.json('.egc1/instrument-resolutions.json') || this.resolutions;
            if (!rejected && this.flags(id).needsAttention) { throw new Error('Resolve the instrument attention flag before approving the corrected sound'); }
            const admission = {version:1, method:PREPARATION, reviewedAt:review.updatedAt, decidedAt:stamp(),
                state:rejected ? 'rejected' : 'approved', originalId:row.id, originalPrediction:clone(item.prediction),
                originalPolicy:clone(item.policy), originalPreparation:clone(row.preparation || null), judgement:clone(review)};
            if (rejected) { row.state = 'rejected'; }
            else {
                const start = review.boundaries?.attackFrame ?? item.startFrame, end = review.boundaries?.endFrame ?? item.endFrame;
                if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > item.sourceFrames || end - start >= item.rate * 60) { throw new Error('Choose valid playable start/end marks shorter than 60 seconds'); }
                if (review.quality === 'reject' && (review.boundaries?.attackFrame == null || review.boundaries?.endFrame == null)) { throw new Error('Mark both corrected boundaries before approving a rejected extraction'); }
                const file = await this.folder.file(item.sourcePath);
                if (!file || await hashFile(file) !== item.sourceKey) {
                    await this.withholdItem(item,'original-source-changed');
                    throw new Error('Original audio changed; reprocess before approval');
                }
                const info = await audioInfo(file);
                if (info.rate !== item.rate || info.frames && info.frames !== item.sourceFrames) { throw new Error('Source geometry differs from the prepared metadata'); }
                let channels;
                if (info.compressed) {
                    if (!globalThis.OfflineAudioContext) { throw new Error('Compressed manual approval requires browser decoding'); }
                    const decoded = await new OfflineAudioContext(2,1,info.rate).decodeAudioData(await file.arrayBuffer());
                    channels = [decoded.getChannelData(0).slice(start,end)];
                } else { channels = [ (await readWav(file,info,start,end))[0] ]; }
                if (signalFacts(channels[0],item.rate).silent) { throw new Error('The selected range contains no audible sound'); }
                let analysis;
                if (this.options.analyse) { analysis = await this.options.analyse(channels, item.rate); }
                else {
                    const {Inference,PIPELINE} = await import('../inference.js');
                    const inference = new Inference(event => { if (event.stage) { this.progress(event.stage); } });
                    analysis = {...await inference.analyse(channels,item.rate,null,false), pipeline:PIPELINE};
                }
                const transients = value.transients;
                if (!Array.isArray(transients) || transients.some((at,i) => !Number.isInteger(at) || at < start || at >= end || (i && at <= transients[i-1]))) { throw new Error('Chop positions must be ordered source frames inside the marked phrase'); }
                if (review.tags.includes('drums') && !transients.length) { throw new Error('Approve at least one attack for a drum sound'); }
                const root = value.root ?? null;
                if (root !== null && (!Number.isFinite(root) || root < 0 || root > 127)) { throw new Error('Root note must be between MIDI 0 and 127'); }
                if ((review.reasons.includes('wrong-root') || review.tags.includes('synth') && !analysis.pitch.hasRoot) && root === null) { throw new Error('Specify the corrected root note before approval'); }
                const beats = value.beats ?? null;
                if (review.tags.includes('loops') && (!Number.isInteger(beats) || beats < 2 || beats > 128)) { throw new Error('Specify the number of beats in the marked loop phrase'); }
                const base = {...row, samples:end-start, channels:1, tags:clone(review.tags), tagsSource:'manual', needsReview:false,
                    provenance:{kind:'separated',sourceId:item.sourceKey,sourcePath:item.sourcePath,sourceSamples:item.sourceFrames,rate:item.rate,start,end}};
                const relative = transients.map(at => at-start);
                row.output = await playableOutput(this.folder,base,analysis,channels,{start:0,end:end-start},
                    {transients:relative, root, manual:true, phrase:beats ? {pulses:beats,confidence:1} : null});
                row.output.preparation = {...row.output.preparation,reasons:[],approvedManually:true};
                admission.correction = {start,end,transients:clone(transients),root,beats,outputId:row.output.id};
                row.tags = clone(review.tags); row.tagsSource = 'manual'; row.state = 'ready';
            }
            if (row.browserKind === 'hit') { row.reviewId = id; }
            row.admission = admission;
            row.preparation = {...row.preparation,method:PREPARATION};
            workspace.decisions = {...workspace.decisions,[id]:[...(workspace.decisions?.[id] || []),clone(admission)]};
            await publishWorkspace(this.folder,workspace);
            this.workspace = workspace; item.publication = row.state; item.admission = admission;
            return {published:!rejected, state:row.state, outputId:row.output?.id};
        });
    }
    async request(path, value) {
        if (path.startsWith('/api/session')) { if (path.includes('refresh=1')) { await this.initialise(); } return this.session(); }
        if (path === '/api/export') { return this.export(); }
        const id = path.split('/').pop();
        if (path.startsWith('/api/review/')) { return this.save(id,value); }
        if (path.startsWith('/api/admit/')) { return this.admit(id,value); }
        if (path.startsWith('/api/withhold/')) { return this.admit(id,value,true); }
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
            return this.publication(async () => {
                const disk = await this.folder.json('.egc1/evaluation.json');
                const action = (disk || this.data).history.at(-1);
                if (action && this.items.has(action.id)) { await this.withholdItem(this.item(action.id),'review-undone'); }
                return this.commit(() => {
                const action = this.data.history.pop(); if (!action) { return {id:null}; }
                if (action.previous) { this.data.reviews[action.id] = action.previous; } else { delete this.data.reviews[action.id]; }
                this.data.lastComparison = this.data.reviews[action.id] ? action.id : this.data.history.at(-1)?.id;
                return {id: action.id};
                });
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
                    const aliases = [id,...(item.reviewAliases || [])];
                    if (!row || (row.revision || 0) !== group.revision || (!aliases.includes(group.id) && !aliases.some(alias=>row.members?.includes(alias)))) { throw new Error('Instrument flag changed. Refresh before resolving.'); }
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
        const reviews = clone(this.data.reviews);
        return {version:1, exportedAt:stamp(), datasetFingerprint:this.fingerprint, taxonomy:CATEGORIES, reviews,
            admissions:clone(this.workspace.decisions || {}),
            summary:{reviewed:Object.keys(reviews).length, blind:Object.values(reviews).filter(row => !row.assisted).length, unsure:Object.values(reviews).filter(row => row.certainty === 'unsure').length,
                comparisons:Object.fromEntries(['way-off','close','pipeline-better'].map(rating => [rating,Object.values(reviews).filter(row => row.comparison?.rating === rating).length]))}};
    }
    async audio(path) {
        const id = path.split('/').pop(), item = this.item(id), source = path.startsWith('/api/source/');
        let relative = source ? item.sourcePath : item.path, expected = source ? item.sourceKey : item.mediaKey;
        if (path.startsWith('/api/published/')) {
            const workspace = await readWorkspace(this.folder), manifest = await this.folder.json('.egc1/library.json');
            const row = workspace.entries.find(row => row.id === item.analysisId && canonicalPath(row.path) === canonicalPath(item.path));
            const output = row?.output || row;
            if (row?.state !== 'ready' || !manifest.entries.some(entry => entry.id === output.id && entry.state === 'ready')) { throw new Error('This sound is excluded from the playable library'); }
            relative = output.path; expected = output.id;
        }
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
        await this.publication(async () => {
            for (const [id] of accepted) { await this.withholdItem(this.item(id),'imported-review'); }
            return this.commit(() => {
            for (const [id,row] of accepted) {
                const current = this.data.reviews[id];
                if (!current || row.updatedAt > current.updatedAt) { this.data.reviews[id] = clone(row); }
                if (row.assisted) { this.data.exposures[id] ||= row.updatedAt || stamp(); }
            }
            });
        });
        return accepted.length;
    }
}
