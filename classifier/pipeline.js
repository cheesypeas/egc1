import {audioInfo, readWav, scanWavRegions, energyEnvelope, splitEnvelope, encodeWav, hashFile, hashBytes} from './audio.js';
import {Inference, PIPELINE, FRONTEND} from './inference.js';
import {classifyScores, roleEvidence, nameHints, applyHints, bankSummary, BANKS} from './taxonomy.js';
import {Folder, validAnalysis, validEmbedding, validOverrides, validBanks} from './storage.js';
import {assessPreparation, playableOutput, publishWorkspace, readWorkspace, PREPARATION, reviewIdentity} from './preparation.js';

const IMPORT_METHOD = 'browser-silence-rms-1:5ms:350ms:20ms:50ms:manual-long-v2';
const sleep = () => new Promise(resolve => setTimeout(resolve, 0));
const sourceOf = row => row.provenance?.sourcePath || row.path;

export class Pipeline {
    constructor(emit, decode, options = {}) {
        this.emit = emit;
        this.decode = decode;
        this.inference = new Inference(event => {
            if (event.type === 'stage') { this.stage(event.stage); }
            else { this.emit(event); }
        }, options);
        this.pause = false;
        this.running = false;
        this.folder = null;
    }
    stage(stage, extra = {}) {
        this.recordStage();
        this.stageName = stage.replace(/ \(\d+\/\d+\)$/, '').replace(/Processing region \d+\/\d+/, 'Processing region');
        this.stageStarted = performance.now();
        this.emit({type: 'stage', stage, ...extra});
    }
    recordStage() {
        if (this.stageName && this.stageTimings) {
            this.stageTimings[this.stageName] = (this.stageTimings[this.stageName] || 0) + performance.now() - this.stageStarted;
        }
        this.stageName = null;
    }
    async run({handle, files, options}) {
        this.running = true;
        this.options = options;
        this.stageTimings = {};
        this.stageName = null;
        const runStarted = performance.now();
        this.pipeline = `${PIPELINE}:${options.beats ? 'beat-this-c5c1466e08abdb03' : 'no-beats'}`;
        this.folder = new Folder(handle, files, event => {
            if (event.type === 'stage') { this.stage(event.stage); }
            else { this.emit(event); }
        });
        try {
            this.stage('Opening saved metadata');
            await this.folder.initialise({locked:true});
            this.stage('Finding samples in your folder');
            const sources = await this.folder.scan();
            if (!sources.length) { throw new Error('No audio files found. Choose a folder containing WAV, AIFF, FLAC or Ogg samples, including subfolders.'); }
            const previous = await readWorkspace(this.folder);
            if (previous && (previous.version !== 1 || !Array.isArray(previous.entries))) { throw new Error('This library uses an unsupported metadata format. Its existing metadata has been left untouched.'); }
            this.overrides = validOverrides(await this.folder.json('.egc1/overrides.json'));
            this.reviews = (await this.folder.json('.egc1/evaluation.json'))?.reviews || {};
            this.previousRows = new Map((previous?.entries || []).map(row => [row.path, row]));
            this.feedback = await this.folder.json('.egc1/instrument-feedback.json');
            if (this.feedback && (this.feedback.version !== 1 || !this.feedback.items || typeof this.feedback.items !== 'object')) { throw new Error('Existing instrument feedback is invalid. Restore it before processing; no review marks have been replaced.'); }
            const resolutions = await this.folder.json('.egc1/instrument-resolutions.json');
            this.resolutions = resolutions?.resolutions || {};
            const config = await this.folder.json('.egc1/banks.json');
            if (!config) { await this.folder.writeJson('.egc1/banks.json', BANKS); }
            else { validBanks(config); }
            this.banks = config || BANKS;
            const policy = (await this.inference.prototypesPromise).policy;
            this.policy = {...policy, frontend: FRONTEND, nameHints: options.hints, manualTags: true, browserRuntime: 'onnxruntime-web-1.22.0'};
            this.report = {version: 1, started: new Date().toISOString(), pipeline: this.pipeline, policy: this.policy, options: {...options},
                sourceFiles: sources.length, completedFiles: 0, readySamples: 0, reusedAnalysis: 0,
                newEmbeddings: 0, reusedEmbeddings: 0, separatedRegions: 0, kits: 0, hits: 0, pendingReview: 0, failures: [], predictions: {}};
            const paths = new Set(sources.map(source => source.path));
            this.rows = new Map((previous?.entries || []).filter(row => paths.has(sourceOf(row))).map(row => [row.path, structuredClone(row)]));
            for (const row of this.rows.values()) {
                if (row.state !== 'ready') { continue; }
                const flags = await this.flags(row.id, row.provenance);
                if ((!row.admission && row.preparation?.method !== PREPARATION) || flags.needsAttention) {
                    row.state = 'needs-review'; row.preparation = {...row.preparation, reasons:[flags.needsAttention ? 'instrument-attention' : 'awaiting-validation']};
                }
            }
            this.manifest = {version: 1, pipeline: this.pipeline, producer: 'egc.one browser classifier', state: 'processing',
                decisions:previous?.decisions || {},
                classification: {...this.policy, done: 0, total: sources.length, failed: 0}, entries: [...this.rows.values()]};
            await this.publish();
            this.emit({type: 'scanned', total: sources.length});
            for (let index = 0; index < sources.length; index++) {
                if (this.pause) { break; }
                const source = sources[index];
                this.current = source.path;
                this.emit({type: 'file', path: source.path, index, total: sources.length});
                for (const [key, row] of this.rows) { if (sourceOf(row) === source.path && !row.reviewId) { this.rows.delete(key); } }
                try {
                    const file = source.file || await source.handle.getFile();
                    this.stage('Checking sample identity');
                    const id = await hashFile(file, fraction => this.emit({type: 'detail', fraction}));
                    for (const row of this.rows.values()) {
                        if (row.reviewId && sourceOf(row) === source.path && row.provenance?.sourceId !== id) {
                            row.state = 'needs-review'; row.preparation = {...row.preparation,reasons:['original-source-changed']};
                        }
                    }
                    const info = await audioInfo(file);
                    let decoded = null;
                    if (info.compressed) {
                        if (file.size > 128 * 1024 * 1024 || (info.frames && info.frames * info.channels > 32000000)) {
                            throw new Error('This compressed source is too large for browser decoding. Convert it to WAV to use streaming region detection.');
                        }
                        this.stage('Decoding compressed audio');
                        decoded = await this.decode(file, info.rate);
                        if (decoded.length !== info.channels || (info.frames && decoded[0].length !== info.frames)) { throw new Error('Browser decoding does not match the source dimensions. Convert this file to PCM WAV.'); }
                        info.frames = decoded[0].length;
                    }
                    const regions = await this.regions(file, info, id, source.path, decoded);
                    let sourceComplete = true;
                    for (let region = 0; region < regions.length; region++) {
                        const item = regions[region];
                        if (item.info.frames >= item.info.rate * 60) {
                            await this.manualSource(item);
                            continue;
                        }
                        this.stage(regions.length > 1 ? `Processing region ${region + 1}/${regions.length}` : 'Processing sample');
                        try {
                            const result = await this.prepare(item, 'sample');
                            this.rows.set(result.row.path, result.row);
                            if (result.row.state === 'ready') { this.report.readySamples++; }
                            else { this.report.pendingReview++; }
                            this.report.predictions[result.row.tags.join(' + ')] = (this.report.predictions[result.row.tags.join(' + ')] || 0) + 1;
                            this.emit({type: 'result', row: result.row, analysis: result.data, cached: result.cached, feedback: await this.flags(result.row.id, result.row.provenance)});
                            if (options.kits && result.row.state === 'ready' && result.row.tags.includes('drum-loop') && !result.row.preparation?.warnings?.includes('uncertain-chop-map')) {
                                try { await this.kit(item, result); }
                                catch (error) { this.failure(`${item.path} [kit export]`, error); }
                            }
                        } catch (error) { this.failure(item.path, error, item.id, item.provenance); }
                        this.emit({type: 'progress', completed: index, within: (region + 1) / regions.length, total: sources.length, report: this.report});
                        // The final region is published below with the completed-file
                        // counter. Avoid writing the entire catalogue twice per file.
                        if (region + 1 < regions.length) { await this.publish(); }
                        await sleep();
                        if (this.pause && region + 1 < regions.length) { sourceComplete = false; break; }
                    }
                    if (source.handle) {
                        const after = await source.handle.getFile();
                        if (after.size !== file.size || after.lastModified !== file.lastModified) {
                            for (const [key, row] of this.rows) { if (sourceOf(row) === source.path) { this.rows.delete(key); } }
                            throw new Error('The source changed during processing. Run this folder again.');
                        }
                    }
                    if (!sourceComplete) { break; }
                } catch (error) { this.failure(source.path, error); }
                this.report.completedFiles++;
                this.manifest.classification.done = this.report.completedFiles;
                this.manifest.classification.failed = this.report.failures.length;
                await this.publish();
                this.emit({type: 'progress', completed: index + 1, within: 0, total: sources.length, report: this.report});
                await sleep();
            }
            this.mergeDuplicates();
            this.manifest.state = this.pause ? 'processing' : this.report.failures.length ? 'complete-with-errors' : 'complete';
            this.report.state = this.pause ? 'paused' : this.manifest.state;
            this.report.finished = new Date().toISOString();
            await this.publish();
            this.stage('Summarising banks');
            this.summary = await this.summariseBanks();
            this.report.bankSummary = this.summary;
            this.recordStage();
            this.report.timings = {elapsedMs: performance.now() - runStarted, stagesMs: {...this.stageTimings},
                metadataWriteMs: this.folder.writeMilliseconds, metadataWrites: this.folder.writeCount};
            await this.folder.writeJson('.egc1/browser/report.json', this.report);
            this.emit({type: this.pause ? 'paused' : 'complete', report: this.report, rows: [...this.rows.values()]});
        } finally { this.running = false; }
    }
    async flags(id, provenance, output = null) {
        const review = provenance ? await hashBytes(new TextEncoder().encode(`region-v1:${provenance.sourceId}:${provenance.start}:${provenance.end}:${id}`)) : id;
        const key = `s-${review}`, result = {favourite: false, needsAttention: false}, keys = new Set([key]);
        if (output) { keys.add(await reviewIdentity({...output,reviewId:null})); }
        for (const row of this.previousRows?.values() || []) {
            if (row.id !== id) { continue; }
            if (row.reviewId) { keys.add(row.reviewId); }
            if (row.output) { keys.add(await reviewIdentity({...row.output,reviewId:null})); }
        }
        for (const [group, item] of Object.entries(this.feedback?.items || {})) {
            if (!keys.has(group) && ![...keys].some(key=>item.members?.includes(key))) { continue; }
            const token = item.attentionToken || `${group}:${item.revision || 0}`;
            result.favourite ||= Boolean(item.favourite);
            result.needsAttention ||= Boolean(item.needsAttention && this.resolutions[token]?.id !== group);
        }
        return result;
    }
    failure(path, error, id = null, provenance = null) {
        const message = error instanceof Error ? error.message : String(error);
        this.report.failures.push({path, error: message});
        const row = {path, state: 'failed', error: message, ...(id ? {id} : {}), ...(provenance ? {provenance} : {})};
        this.rows.set(path, row);
        this.emit({type: 'result', row});
    }
    async regions(file, info, id, path, decoded) {
        if (!this.options.split) {
            return [{file, info, id, path, channels: decoded}];
        }
        const cached = await this.folder.json(`.egc1/imports/${id}.json`);
        if (!this.options.force && cached?.method === IMPORT_METHOD && cached.id === id && cached.rate === info.rate && cached.samples === info.frames && cached.channels === info.channels && Array.isArray(cached.regions)) {
            if (!cached.split && !cached.regions.length) { return [{file, info, id, path, channels: decoded}]; }
            if (cached.split && cached.regions.length) {
                const items = [];
                let previous = 0;
                for (const region of cached.regions) {
                    if (!Number.isInteger(region.start) || !Number.isInteger(region.end) || region.start < previous || region.end <= region.start || region.end > info.frames ||
                        !region.path?.startsWith(`.egc1/regions/${id}/`) || !/^[0-9a-f]{64}$/.test(region.id)) { throw new Error('Invalid cached region metadata. Use “Reanalyse existing audio” to rebuild it.'); }
                    previous = region.end;
                    let audio = null;
                    try { audio = await this.folder.file(region.path); }
                    catch (error) { if (error.name !== 'NotFoundError') { throw error; } }
                    if (!audio || await hashFile(audio) !== region.id) { items.length = 0; break; }
                    const regionInfo = await audioInfo(audio);
                    if (regionInfo.frames !== region.end - region.start || regionInfo.rate !== info.rate || regionInfo.channels !== info.channels) { items.length = 0; break; }
                    items.push({file: audio, info: regionInfo, id: region.id, path: region.path,
                        provenance: this.provenance(id, path, info, region.start, region.end)});
                }
                if (items.length === cached.regions.length) {
                    if (cached.manualSource) { items.push({file,info,id,path,channels:decoded}); }
                    this.report.separatedRegions += items.length;
                    for (const skipped of cached.skipped || []) { this.failure(`${path} [${(skipped.start / info.rate).toFixed(2)}–${(skipped.end / info.rate).toFixed(2)} s]`, new Error(skipped.error)); }
                    return items;
                }
            }
        }
        this.stage('Finding silence-separated sounds');
        const segmentation = decoded ? splitEnvelope(energyEnvelope(decoded, Math.max(1, Math.floor(info.rate * .005))), info.frames, info.rate) :
            await scanWavRegions(file, info, fraction => this.emit({type: 'detail', fraction}));
        const imported = {version: 1, method: IMPORT_METHOD, id, rate: info.rate, samples: info.frames, channels: info.channels,
            threshold: segmentation.threshold, split: segmentation.split, regions: [], skipped: []};
        if (!segmentation.split) {
            await this.folder.writeJson(`.egc1/imports/${id}.json`, imported);
            return [{file, info, id, path, channels: decoded}];
        }
        if (!segmentation.bounds.length) { throw new Error('No audible regions found in this long source.'); }
        const items = [];
        for (const {start, end} of segmentation.bounds) {
            if (end - start >= info.rate * 60) {
                // Retain usable shorter regions and report an unplayable section.
                if (!items.some(item => item.path === path)) { items.push({file, info, id, path, channels:decoded}); }
                imported.manualSource = true;
                continue;
            }
            const channels = decoded ? decoded.map(ch => ch.slice(start, end)) : await readWav(file, info, start, end);
            const bytes = encodeWav(channels, info.rate), regionId = await hashBytes(bytes);
            const relative = `.egc1/regions/${id}/${start}-${end}.wav`;
            const blob = new Blob([bytes], {type: 'audio/wav'});
            await this.folder.write(relative, blob);
            const regionInfo = await audioInfo(blob);
            items.push({file: blob, info: regionInfo, id: regionId, path: relative, provenance: this.provenance(id, path, info, start, end)});
            imported.regions.push({start, end, path: relative, id: regionId});
        }
        if (!items.length) { throw new Error('No regions are short enough for the sampler.'); }
        this.report.separatedRegions += items.length;
        await this.folder.writeJson(`.egc1/imports/${id}.json`, imported);
        return items;
    }
    async manualSource(item) {
        const {info,id,path,file} = item;
        const role = () => ({samples:info.frames,rate:info.rate,transients:[],beats:[],downbeats:[],hasRoot:false});
        const data = {version:1,id,pipeline:this.pipeline,channels:info.channels,pitch:role(),loop:role(),vocal:role()};
        await this.folder.writeJson(`.egc1/entries/${id}.json`,data);
        const row = {id,path,bytes:file.size,samples:info.frames,rate:info.rate,channels:info.channels,state:'needs-review',tags:['unclassified'],
            preparation:{method:PREPARATION,reasons:['choose-shorter-phrase'],bounds:{start:0,end:info.frames}},classification:this.policy};
        const previous = this.previousRows.get(path), review = this.reviews['s-'+id];
        if (previous?.id === id && previous.admission?.reviewedAt === review?.updatedAt && previous.admission) {
            Object.assign(row,{state:previous.state,tags:previous.tags,admission:previous.admission});
            if (previous.output && row.state === 'ready') {
                const file = await this.folder.file(previous.output.path);
                if (file && await hashFile(file) === previous.output.id) { row.output = previous.output; }
                else { row.state = 'needs-review'; }
            }
        }
        if ((await this.flags(id,null,row.output)).needsAttention) {
            row.state = 'needs-review'; row.preparation.reasons.push('instrument-attention');
        }
        this.rows.set(path,row);
        if (row.state === 'ready') { this.report.readySamples++; } else { this.report.pendingReview++; }
        this.emit({type:'result',row,analysis:data});
    }
    provenance(id, path, info, start, end) { return {kind: 'separated', sourceId: id, sourcePath: path, sourceSamples: info.frames, rate: info.rate, start, end}; }
    async prepare(item, kind) {
        const {id, info, file} = item;
        const previous = this.previousRows.get(item.path);
        const protectApproved = previous?.admission && previous.state === 'ready' && previous.output?.id === id;
        const rawCache = await this.folder.json(`.egc1/browser/raw-analysis/${id}.json`);
        const rawPipeline = rawCache?.pipeline;
        let data = rawCache || await this.folder.json(`.egc1/entries/${id}.json`);
        let embedding = await this.folder.json(`.egc1/browser/embeddings/${id}.json`);
        const assets = await this.inference.assetsPromise;
        const analysisCached = !this.options.force && validAnalysis(data, id, this.pipeline, info);
        const embeddingCached = !this.options.force && validEmbedding(embedding, id, info, FRONTEND, assets.models.audio.sha256);
        // Acceptance checks inspect the audible signal even when model results
        // are cached; model confidence alone is not a publication decision.
        if (!item.channels) { item.channels = info.compressed ? await this.decode(file, info.rate) : await readWav(file, info); }
        if (analysisCached) {
            this.report.reusedAnalysis++;
            if (data.pipeline !== this.pipeline) {
                data.pipeline = this.pipeline;
                if (!protectApproved) { await this.folder.writeJson(`.egc1/entries/${id}.json`,data); }
            }
        }
        else {
            data = await this.inference.analyse(item.channels, info.rate, info.root, this.options.beats && kind !== 'hit');
            data = {...data, id, pipeline: this.pipeline, kitCandidatesVersion: 0};
            if (!protectApproved) { await this.folder.writeJson(`.egc1/entries/${id}.json`, data); }
        }
        if (!rawCache || rawPipeline !== this.pipeline || !analysisCached) { await this.folder.writeJson(`.egc1/browser/raw-analysis/${id}.json`,data); }
        if (embeddingCached) {
            this.report.reusedEmbeddings++;
            if (embedding.frontend !== FRONTEND) {
                embedding.frontend = FRONTEND;
                await this.folder.writeJson(`.egc1/browser/embeddings/${id}.json`,embedding);
            }
        }
        else {
            embedding = {...await this.inference.audio(item.channels, info.rate), id};
            await this.folder.writeJson(`.egc1/browser/embeddings/${id}.json`, embedding);
            this.report.newEmbeddings++;
        }
        const scores = await this.inference.scores(embedding);
        const raw = classifyScores(scores, info.frames / info.rate, data.loop, kind, embedding.peak < 1e-5);
        const evidence = roleEvidence(raw.tags, scores);
        const semantic = {version: 1, id, rate: info.rate, samples: info.frames, analysisPipeline: this.pipeline,
            policy: {...this.policy, nameHints: false}, tags: raw.tags, reason: raw.reason, scores, roleEvidence: evidence, needsReview: true};
        await this.folder.writeJson(`.egc1/semantic/${id}.json`, semantic);
        const hints = this.options.hints && kind !== 'hit' ? nameHints(sourceOf(item)) : [];
        const substantiveHints = hints.filter(tag => tag !== 'recorded');
        const assigned = substantiveHints.length ? applyHints(raw.tags, hints) : [...raw.tags, ...hints];
        const manual = this.overrides[id];
        const recordedId = item.provenance?.sourceId || id;
        const recorded = await this.folder.json(`.egc1/recordings/${recordedId}.json`);
        const tags = [...new Set(manual || assigned)];
        if (recorded?.version === 1 && recorded.id === recordedId && !tags.includes('recorded')) { tags.push('recorded'); }
        const preparation = assessPreparation(item.channels, info.rate, data, tags, evidence);
        const row = {id, path: item.path, bytes: file.size, state: preparation.reasons.length ? 'needs-review' : 'ready', rate: info.rate, samples: info.frames, channels: info.channels,
            tags, tagsSource: manual ? 'manual' : substantiveHints.length ? 'name+audio-model' : 'audio-model', needsReview: !manual,
            preparation,
            classification: {...this.policy, ...(substantiveHints.length ? {hintMethod: 'token-hints-v2', hintTags: hints, audioTags: raw.tags} : {})},
            browserRoleEvidence: evidence, ...(item.provenance ? {provenance: item.provenance} : {})};
        const reviewId = item.provenance ? 's-' + await hashBytes(new TextEncoder().encode(`region-v1:${item.provenance.sourceId}:${item.provenance.start}:${item.provenance.end}:${id}`)) : 's-' + id;
        const review = this.reviews[reviewId];
        const flags = await this.flags(id, item.provenance);
        const pendingDecision = previous?.id === id && previous.state !== 'ready' && previous.preparation?.reasons?.some(reason=>
            ['manual-category-changed','human-review','imported-review','review-undone','instrument-attention'].includes(reason));
        if (pendingDecision || flags.needsAttention || (review && (review.quality === 'reject' || review.certainty !== 'clear' || review.reasons?.length ||
            review.boundaries?.attackFrame != null || review.boundaries?.endFrame != null))) {
            row.state = 'needs-review'; row.preparation.reasons.push(flags.needsAttention ? 'instrument-attention' : 'human-review');
        }
        if (previous?.admission && previous.id === id && previous.admission.reviewedAt === review?.updatedAt) {
            Object.assign(row, {state: previous.state, admission: previous.admission, tags: previous.tags, tagsSource: previous.tagsSource});
            if (previous.output && previous.state === 'ready') {
                const outputFile = await this.folder.file(previous.output.path);
                if (!outputFile || await hashFile(outputFile) !== previous.output.id) { row.state = 'needs-review'; row.preparation.reasons.push('missing-approved-output'); }
                else { row.output = previous.output; }
            }
        }
        if (row.state === 'ready' && !row.output && kind !== 'hit') {
            row.output = await playableOutput(this.folder, row, data, item.channels, preparation.bounds,
                {transients: preparation.attacks.accepted, phrase: preparation.phrase});
        }
        if ((await this.flags(id,item.provenance,row.output)).needsAttention) {
            row.state = 'needs-review'; row.preparation.reasons = [...new Set([...row.preparation.reasons,'instrument-attention'])];
        }
        return {row, data, cached: analysisCached && embeddingCached};
    }
    async kit(item, result) {
        const parent = result.row.output || result.row;
        const file = await this.folder.file(parent.path), info = await audioInfo(file);
        item = {id:parent.id,path:parent.path,file,info,channels:await readWav(file,info)};
        result = {row:parent,data:await this.folder.json(`.egc1/entries/${parent.id}.json`)};
        const candidates = kitCandidates(item.channels, item.info.rate, result.data.loop.transients);
        const selected = [];
        for (const candidate of candidates) {
            if (selected.length === 8) { break; }
            if (selected.some(previous => previous.shape.reduce((sum, v, i) => sum + (v - candidate.shape[i]) ** 2, 0) < .025)) { continue; }
            selected.push(candidate);
        }
        if (!selected.length) { return; }
        const hits = [];
        for (const [index, hit] of selected.entries()) {
            this.stage(`Preparing drum kit · hit ${index + 1}/${selected.length}`);
            const channels = item.channels.map(ch => ch.slice(hit.start, hit.end));
            const fade = Math.min(Math.floor(channels[0].length / 4), Math.floor(item.info.rate * .002));
            for (const channel of channels) {
                for (let i = 0; i < fade; i++) { channel[channel.length - fade + i] *= 1 - i / fade; }
            }
            const bytes = encodeWav(channels, item.info.rate), id = await hashBytes(bytes);
            const name = `hit-${String(index + 1).padStart(2, '0')}.wav`, path = `.egc1/kits/${item.id}/${name}`;
            if ([...this.rows.values()].some(row=>row.reviewId && row.kitParentId === item.id && row.id === id)) { continue; }
            const file = new Blob([bytes], {type: 'audio/wav'});
            await this.folder.write(path, file);
            const info = await audioInfo(file);
            const classified = await this.prepare({id, file, path, info}, 'hit');
            if (classified.row.state !== 'ready') {
                const queuedPath = `.egc1/regions/${parent.provenance.sourceId}/${parent.provenance.start+hit.start}-${parent.provenance.start+hit.end}-candidate.wav`;
                await this.folder.write(queuedPath,file);
                this.rows.set(queuedPath, {...classified.row, path:queuedPath, browserKind: 'hit', kitParentId: item.id,
                    provenance:{...parent.provenance,start:parent.provenance.start+hit.start,end:parent.provenance.start+hit.end}});
                this.report.pendingReview++;
                continue;
            }
            hits.push({file: name, start: hit.start, end: hit.end, role: 'unassigned', id, browserTags: classified.row.tags});
            this.report.hits++;
        }
        if (!hits.length) { return; }
        const kit = {version: 1, sourceId: item.id, sourcePath: item.path, rate: item.info.rate, needsReview: true, origin: 'extracted', hits};
        await this.folder.writeJson(`.egc1/kits/${item.id}/kit.json`, kit);
        this.report.kits++;
        this.emit({type: 'kit', sourceId: item.id, count: hits.length});
    }
    mergeDuplicates() {
        const groups = new Map();
        for (const row of this.rows.values()) {
            if (row.state !== 'ready') { continue; }
            if (!groups.has(row.id)) { groups.set(row.id, []); }
            groups.get(row.id).push(row);
        }
        for (const group of groups.values()) {
            if (group.length < 2) { continue; }
            const tags = this.overrides[group[0].id] || [...new Set(group.flatMap(row => row.tags))];
            const cleaned = tags.length > 1 ? tags.filter(tag => tag !== 'unclassified') : tags;
            for (const row of group) { row.tags = cleaned; if (row.output) { row.output.tags = cleaned; } }
        }
    }
    async publish() {
        this.manifest.entries = [...this.rows.values()];
        if(this.manifest.entries.some(row=>row.state==='ready' && row.tags?.includes('loops'))) { this.stage('Comparing similar loops'); }
        await publishWorkspace(this.folder, this.manifest, {progress:stage=>this.emit({type:'stage',stage})});
        if(this.report) {
            this.report.readySamples=this.manifest.entries.filter(row=>row.state==='ready' && !row.duplicateOf).length;
            this.report.loopSimilarity=this.manifest.loopSimilarity;
        }
    }
    async summariseBanks() {
        const kits = new Map();
        if (this.banks.banks.flat().some(bank => bank.kind === 'kits')) {
            for (let row of this.rows.values()) {
                if (row.state !== 'ready' || row.duplicateOf || kits.has(row.id)) { continue; }
                row = row.output || row;
                try {
                    const kit = await this.folder.json(`.egc1/kits/${row.id}/kit.json`);
                    if (kit?.version !== 1 || kit.sourceId !== row.id || kit.rate !== row.rate ||
                        !Array.isArray(kit.hits) || !kit.hits.length || kit.hits.length > 8) { continue; }
                    let valid = true;
                    for (const hit of kit.hits) {
                        if (!Number.isInteger(hit.start) || !Number.isInteger(hit.end) || hit.start < 0 ||
                            hit.end <= hit.start || hit.end > row.samples || typeof hit.file !== 'string' ||
                            !/^[^./\\][^/\\]*\.wav$/i.test(hit.file)) { valid = false; break; }
                        const audio = await this.folder.file(`.egc1/kits/${row.id}/${hit.file}`).catch(error => {
                            if (error.name === 'NotFoundError') { return null; } throw error;
                        });
                        if (!audio) { valid = false; break; }
                        const info = await audioInfo(audio);
                        if (info.frames !== hit.end - hit.start || info.rate !== row.rate || info.channels !== row.channels) { valid = false; break; }
                    }
                    if (valid) { kits.set(row.id, kit.hits.length); }
                } catch (error) {
                    // An unreadable old kit must not prevent the sample report.
                    this.emit({type: 'notice', message: `Could not include the kit for ${row.path} in the bank summary: ${error.message}`});
                }
            }
        }
        return bankSummary(this.banks, [...this.rows.values()].filter(row => row.state === 'ready' && !row.duplicateOf).map(row => row.output || row), kits);
    }
    async correct(id, tags) {
        if (this.running || !this.folder) { throw new Error('Pause processing before changing a classification.'); }
        if (!/^[0-9a-f]{64}$/.test(id) || !Array.isArray(tags) || !tags.length || tags.some(tag => !/^[a-z0-9-]+$/.test(tag))) { throw new Error('Invalid classification correction.'); }
        const overrides = validOverrides(await this.folder.json('.egc1/overrides.json'));
        overrides[id] = tags;
        await this.folder.writeJson('.egc1/overrides.json', overrides);
        this.overrides = overrides;
        for (const row of this.rows.values()) {
            if (row.id !== id) { continue; }
            row.tags = tags; row.tagsSource = 'manual'; row.needsReview = false;
            if (row.output) { row.output.tags = tags; row.output.tagsSource = 'manual'; }
            row.state = 'needs-review'; row.preparation = {...row.preparation,reasons:[...new Set([...(row.preparation?.reasons || []),'manual-category-changed'])]};
            delete row.admission;
        }
        await this.publish();
        this.summary = await this.summariseBanks();
        this.report.bankSummary = this.summary;
        await this.folder.writeJson('.egc1/browser/report.json', this.report);
        this.emit({type: 'corrected', id, tags, summary: this.summary, rows:[...this.rows.values()].filter(row=>row.id===id)});
    }
    async refresh({handle,files}) {
        if (this.running) { throw new Error('Pause processing before refreshing review changes'); }
        this.folder = new Folder(handle,files,this.emit);
        this.manifest = await readWorkspace(this.folder);
        this.rows = new Map(this.manifest.entries.map(row=>[row.path,row]));
        this.banks = validBanks(await this.folder.json('.egc1/banks.json') || BANKS);
        this.report = await this.folder.json('.egc1/browser/report.json') || {failures:[]};
    }
}

// Native KitCandidates/ExportSampleLibraryKit rules, using the same detected
// attacks. Silent prefixes and near-identical timbres do not become kit pads.
export function kitCandidates(audio, rate, transients) {
    const length = audio[0].length, result = [], minimum = Math.ceil(rate * .025);
    const peakIn = (left, right) => {
        let peak = 0;
        for (const channel of audio) { for (let i = left; i < right; i++) { peak = Math.max(peak, Math.abs(channel[i])); } }
        return peak;
    };
    let globalPeak = peakIn(0, length);
    if (globalPeak <= 0) { return result; }
    const powerIn = (left, right) => Math.max(...audio.map(channel => {
        let energy = 0;
        for (let i = left; i < right; i++) { energy += channel[i] * channel[i]; }
        return energy / Math.max(1, right - left);
    }));
    for (let i = 0; i < transients.length;) {
        const start = transients[i];
        let next = i + 1;
        const firstEnd = next < transients.length ? transients[next] : length;
        if (firstEnd - start < minimum && peakIn(start, firstEnd) / globalPeak < .01) { i = next; continue; }
        while (next < transients.length && transients[next] - start < minimum) { next++; }
        const end = Math.min(next < transients.length ? transients[next] : length, start + Math.floor(rate * .75));
        i = next;
        const peak = peakIn(start, end);
        if (end - start < minimum || peak / globalPeak < .01) { continue; }
        if (start !== 0 && end - start <= rate * .08) {
            const window = Math.min(end - start, Math.max(1, Math.floor(rate * .012)));
            const previous = Math.max(1e-12, powerIn(Math.max(0, start - window), start));
            const attack = powerIn(start, start + window), tail = powerIn(end - window, end);
            if (!(attack >= 4 * previous || (attack >= 1.5 * previous && attack >= 2 * tail))) { continue; }
        }
        const window = Math.min(end - start, Math.floor(rate * .12)), shape = [];
        let crossings = 0;
        for (let bin = 0; bin < 8; bin++) {
            const left = start + Math.floor(bin * window / 8), right = start + Math.floor((bin + 1) * window / 8);
            let energy = 0;
            for (const channel of audio) {
                for (let frame = left; frame < right; frame++) {
                    energy += channel[frame] * channel[frame];
                    if (frame > start && (channel[frame] > 0) !== (channel[frame - 1] > 0)) { crossings++; }
                }
            }
            shape.push(Math.sqrt(energy / Math.max(1, (right - left) * audio.length)) / peak);
        }
        shape.push(crossings / Math.max(1, window * audio.length));
        result.push({start, end, shape});
    }
    return result;
}
