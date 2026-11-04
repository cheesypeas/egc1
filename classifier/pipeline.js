import {audioInfo, readWav, scanWavRegions, energyEnvelope, splitEnvelope, encodeWav, hashFile, hashBytes} from './audio.js';
import {Inference, PIPELINE, FRONTEND} from './inference.js';
import {classifyScores, roleEvidence, nameHints, applyHints, BANKS} from './taxonomy.js';
import {Folder, validAnalysis, validEmbedding, validOverrides, validBanks} from './storage.js';

const IMPORT_METHOD = 'browser-silence-rms-1:5ms:350ms:20ms:50ms';
const sleep = () => new Promise(resolve => setTimeout(resolve, 0));
const sourceOf = row => row.provenance?.sourcePath || row.path;

export class Pipeline {
    constructor(emit, decode, options = {}) {
        this.emit = emit;
        this.decode = decode;
        this.inference = new Inference(emit, options);
        this.pause = false;
        this.running = false;
        this.folder = null;
    }
    stage(stage, extra = {}) { this.emit({type: 'stage', stage, ...extra}); }
    async run({handle, files, options}) {
        this.running = true;
        this.options = options;
        this.pipeline = `${PIPELINE}:${options.beats ? 'beat-this-c5c1466e08abdb03' : 'no-beats'}`;
        this.folder = new Folder(handle, files, this.emit);
        try {
            this.stage('Finding samples in your folder');
            const sources = await this.folder.scan();
            if (!sources.length) { throw new Error('No audio files found. Choose a folder containing WAV, AIFF, FLAC or Ogg samples, including subfolders.'); }
            const previous = await this.folder.json('.toysampler/library.json');
            if (previous && (previous.version !== 1 || !Array.isArray(previous.entries))) { throw new Error('This library uses an unsupported metadata format. Its existing metadata has been left untouched.'); }
            this.overrides = validOverrides(await this.folder.json('.toysampler/overrides.json'));
            this.feedback = await this.folder.json('.toysampler/instrument-feedback.json');
            if (this.feedback && (this.feedback.version !== 1 || !this.feedback.items || typeof this.feedback.items !== 'object')) { throw new Error('Existing instrument feedback is invalid. Restore it before processing; no review marks have been replaced.'); }
            const resolutions = await this.folder.json('.toysampler/instrument-resolutions.json');
            this.resolutions = resolutions?.resolutions || {};
            const config = await this.folder.json('.toysampler/banks.json');
            if (!config) { await this.folder.writeJson('.toysampler/banks.json', BANKS); }
            else { validBanks(config); }
            const policy = (await this.inference.prototypesPromise).policy;
            this.policy = {...policy, frontend: FRONTEND, nameHints: options.hints, manualTags: true, browserRuntime: 'onnxruntime-web-1.22.0'};
            this.report = {version: 1, started: new Date().toISOString(), pipeline: this.pipeline, policy: this.policy,
                sourceFiles: sources.length, completedFiles: 0, readySamples: 0, reusedAnalysis: 0,
                newEmbeddings: 0, reusedEmbeddings: 0, separatedRegions: 0, kits: 0, hits: 0, failures: [], predictions: {}};
            const paths = new Set(sources.map(source => source.path));
            this.rows = new Map((previous?.entries || []).filter(row => paths.has(sourceOf(row))).map(row => [row.path, row]));
            this.manifest = {version: 1, pipeline: this.pipeline, producer: 'egc.one browser classifier', state: 'processing',
                classification: {...this.policy, done: 0, total: sources.length, failed: 0}, entries: [...this.rows.values()]};
            await this.publish();
            this.emit({type: 'scanned', total: sources.length});
            for (let index = 0; index < sources.length; index++) {
                if (this.pause) { break; }
                const source = sources[index];
                this.current = source.path;
                this.emit({type: 'file', path: source.path, index, total: sources.length});
                for (const [key, row] of this.rows) { if (sourceOf(row) === source.path) { this.rows.delete(key); } }
                try {
                    const file = source.file || await source.handle.getFile();
                    this.stage('Checking sample identity');
                    const id = await hashFile(file, fraction => this.emit({type: 'detail', fraction}));
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
                        this.stage(regions.length > 1 ? `Processing region ${region + 1}/${regions.length}` : 'Processing sample');
                        try {
                            const result = await this.prepare(item, 'sample');
                            this.rows.set(result.row.path, result.row);
                            this.report.readySamples++;
                            this.report.predictions[result.row.tags.join(' + ')] = (this.report.predictions[result.row.tags.join(' + ')] || 0) + 1;
                            this.emit({type: 'result', row: result.row, analysis: result.data, cached: result.cached, feedback: await this.flags(result.row.id, result.row.provenance)});
                            if (options.kits && result.row.tags.includes('drum-loop')) {
                                try { await this.kit(item, result); }
                                catch (error) { this.failure(`${item.path} [kit export]`, error); }
                            }
                        } catch (error) { this.failure(item.path, error, item.id, item.provenance); }
                        this.emit({type: 'progress', completed: index, within: (region + 1) / regions.length, total: sources.length, report: this.report});
                        await this.publish();
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
            await this.folder.writeJson('.toysampler/browser/report.json', this.report);
            this.emit({type: this.pause ? 'paused' : 'complete', report: this.report, rows: [...this.rows.values()]});
        } finally { this.running = false; }
    }
    async flags(id, provenance) {
        const review = provenance ? await hashBytes(new TextEncoder().encode(`region-v1:${provenance.sourceId}:${provenance.start}:${provenance.end}:${id}`)) : id;
        const key = `s-${review}`, result = {favourite: false, needsAttention: false};
        for (const [group, item] of Object.entries(this.feedback?.items || {})) {
            if (group !== key && !item.members?.includes(key)) { continue; }
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
            if (info.frames >= info.rate * 60) { throw new Error('This source is 60 seconds or longer. Enable splitting at silence to extract playable regions.'); }
            return [{file, info, id, path, channels: decoded}];
        }
        const cached = await this.folder.json(`.toysampler/imports/${id}.json`);
        if (!this.options.force && cached?.method === IMPORT_METHOD && cached.id === id && cached.rate === info.rate && cached.samples === info.frames && cached.channels === info.channels && Array.isArray(cached.regions)) {
            if (!cached.split && !cached.regions.length) { return [{file, info, id, path, channels: decoded}]; }
            if (cached.split && cached.regions.length) {
                const items = [];
                let previous = 0;
                for (const region of cached.regions) {
                    if (!Number.isInteger(region.start) || !Number.isInteger(region.end) || region.start < previous || region.end <= region.start || region.end > info.frames ||
                        !region.path?.startsWith(`.toysampler/regions/${id}/`) || !/^[0-9a-f]{64}$/.test(region.id)) { throw new Error('Invalid cached region metadata. Use “Reanalyse existing audio” to rebuild it.'); }
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
            await this.folder.writeJson(`.toysampler/imports/${id}.json`, imported);
            return [{file, info, id, path, channels: decoded}];
        }
        if (!segmentation.bounds.length) { throw new Error('No audible regions found in this long source.'); }
        const items = [];
        for (const {start, end} of segmentation.bounds) {
            if (end - start >= info.rate * 60) {
                // Retain usable shorter regions and report an unplayable section.
                this.failure(`${path} [${(start / info.rate).toFixed(2)}–${(end / info.rate).toFixed(2)} s]`, new Error('Continuous region is 60 seconds or longer; split it manually.'));
                imported.skipped.push({start, end, error: 'Continuous region is 60 seconds or longer; split it manually.'});
                continue;
            }
            const channels = decoded ? decoded.map(ch => ch.slice(start, end)) : await readWav(file, info, start, end);
            const bytes = encodeWav(channels, info.rate), regionId = await hashBytes(bytes);
            const relative = `.toysampler/regions/${id}/${start}-${end}.wav`;
            const blob = new Blob([bytes], {type: 'audio/wav'});
            await this.folder.write(relative, blob);
            const regionInfo = await audioInfo(blob);
            items.push({file: blob, info: regionInfo, id: regionId, path: relative, provenance: this.provenance(id, path, info, start, end)});
            imported.regions.push({start, end, path: relative, id: regionId});
        }
        if (!items.length) { throw new Error('No regions are short enough for the sampler.'); }
        this.report.separatedRegions += items.length;
        await this.folder.writeJson(`.toysampler/imports/${id}.json`, imported);
        return items;
    }
    provenance(id, path, info, start, end) { return {kind: 'separated', sourceId: id, sourcePath: path, sourceSamples: info.frames, rate: info.rate, start, end}; }
    async prepare(item, kind) {
        const {id, info, file} = item;
        let data = await this.folder.json(`.toysampler/entries/${id}.json`);
        let embedding = await this.folder.json(`.toysampler/browser/embeddings/${id}.json`);
        const assets = await this.inference.assetsPromise;
        const analysisCached = !this.options.force && validAnalysis(data, id, this.pipeline, info);
        const embeddingCached = !this.options.force && validEmbedding(embedding, id, info, FRONTEND, assets.models.audio.sha256);
        if (!analysisCached || !embeddingCached) {
            if (!item.channels) { item.channels = info.compressed ? await this.decode(file, info.rate) : await readWav(file, info); }
        }
        if (analysisCached) { this.report.reusedAnalysis++; }
        else {
            data = await this.inference.analyse(item.channels, info.rate, info.root, this.options.beats && kind !== 'hit');
            data = {...data, id, pipeline: this.pipeline, kitCandidatesVersion: 0};
            await this.folder.writeJson(`.toysampler/entries/${id}.json`, data);
        }
        if (embeddingCached) { this.report.reusedEmbeddings++; }
        else {
            embedding = {...await this.inference.audio(item.channels, info.rate), id};
            await this.folder.writeJson(`.toysampler/browser/embeddings/${id}.json`, embedding);
            this.report.newEmbeddings++;
        }
        const scores = await this.inference.scores(embedding);
        const raw = classifyScores(scores, info.frames / info.rate, data.loop, kind, embedding.peak < 1e-5);
        const evidence = roleEvidence(raw.tags, scores);
        const semantic = {version: 1, id, rate: info.rate, samples: info.frames, analysisPipeline: this.pipeline,
            policy: {...this.policy, nameHints: false}, tags: raw.tags, reason: raw.reason, scores, roleEvidence: evidence, needsReview: true};
        await this.folder.writeJson(`.toysampler/semantic/${id}.json`, semantic);
        const hints = this.options.hints && kind !== 'hit' ? nameHints(sourceOf(item)) : [];
        const substantiveHints = hints.filter(tag => tag !== 'recorded');
        const assigned = substantiveHints.length ? applyHints(raw.tags, hints) : [...raw.tags, ...hints];
        const manual = this.overrides[id];
        const recordedId = item.provenance?.sourceId || id;
        const recorded = await this.folder.json(`.toysampler/recordings/${recordedId}.json`);
        const tags = [...new Set(manual || assigned)];
        if (recorded?.version === 1 && recorded.id === recordedId && !tags.includes('recorded')) { tags.push('recorded'); }
        const row = {id, path: item.path, bytes: file.size, state: 'ready', rate: info.rate, samples: info.frames, channels: info.channels,
            tags, tagsSource: manual ? 'manual' : substantiveHints.length ? 'name+audio-model' : 'audio-model', needsReview: !manual,
            classification: {...this.policy, ...(substantiveHints.length ? {hintMethod: 'token-hints-v2', hintTags: hints, audioTags: raw.tags} : {})},
            browserRoleEvidence: evidence, ...(item.provenance ? {provenance: item.provenance} : {})};
        return {row, data, cached: analysisCached && embeddingCached};
    }
    async kit(item, result) {
        if (!item.channels) { item.channels = item.info.compressed ? await this.decode(item.file, item.info.rate) : await readWav(item.file, item.info); }
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
            const name = `hit-${String(index + 1).padStart(2, '0')}.wav`, path = `.toysampler/kits/${item.id}/${name}`;
            const file = new Blob([bytes], {type: 'audio/wav'});
            await this.folder.write(path, file);
            const info = await audioInfo(file);
            const classified = await this.prepare({id, file, path, info}, 'hit');
            hits.push({file: name, start: hit.start, end: hit.end, role: 'unassigned', id, browserTags: classified.row.tags});
            this.report.hits++;
        }
        const kit = {version: 1, sourceId: item.id, sourcePath: item.path, rate: item.info.rate, needsReview: true, origin: 'extracted', hits};
        await this.folder.writeJson(`.toysampler/kits/${item.id}/kit.json`, kit);
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
            for (const row of group) { row.tags = cleaned; }
        }
    }
    async publish() {
        this.manifest.entries = [...this.rows.values()];
        await this.folder.writeJson('.toysampler/library.json', this.manifest);
    }
    async correct(id, tags) {
        if (this.running || !this.folder) { throw new Error('Pause processing before changing a classification.'); }
        if (!/^[0-9a-f]{64}$/.test(id) || !Array.isArray(tags) || !tags.length || tags.some(tag => !/^[a-z0-9-]+$/.test(tag))) { throw new Error('Invalid classification correction.'); }
        const overrides = validOverrides(await this.folder.json('.toysampler/overrides.json'));
        overrides[id] = tags;
        await this.folder.writeJson('.toysampler/overrides.json', overrides);
        this.overrides = overrides;
        for (const row of this.rows.values()) { if (row.id === id) { row.tags = tags; row.tagsSource = 'manual'; row.needsReview = false; } }
        await this.publish();
        this.emit({type: 'corrected', id, tags});
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
