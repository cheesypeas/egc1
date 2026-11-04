import * as ort from './vendor/ort.wasm.min.mjs';
import createAnalysis from './vendor/analysis.mjs';
import {hashBytes, spectrogram, strongestChannel} from './audio.js';

export const FRONTEND = 'clap48k-r8brain-slaney-repeatpad-three-crops-web-v1';
export const PIPELINE = 'browser-library-1:core-8891981:frontend-r8brain-v1';
ort.env.wasm.numThreads = 1; // Works on ordinary static hosting without COOP/COEP headers.
ort.env.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
ort.env.logLevel = 'warning';

export class Inference {
    constructor(emit, options = {}) {
        this.emit = emit;
        this.options = options;
        this.sessions = new Map();
        this.nativePromise = null;
        this.assetsPromise = fetch(new URL('./assets.json', import.meta.url)).then(r => { if (!r.ok) { throw new Error('Classifier assets are unavailable. Reload the page.'); } return r.json(); });
        this.prototypesPromise = fetch(new URL('./prototypes.json', import.meta.url)).then(r => r.json());
        this.filtersPromise = fetch(new URL('./mel-filters.json', import.meta.url)).then(r => r.json());
    }
    async native() {
        if (!this.nativePromise) {
            this.emit({type: 'stage', stage: 'Preparing audio analysis'});
            this.nativePromise = createAnalysis();
        }
        return this.nativePromise;
    }
    async model(name) {
        if (!this.sessions.has(name)) {
            this.sessions.set(name, this.loadModel(name).catch(error => { this.sessions.delete(name); throw error; }));
        }
        return this.sessions.get(name);
    }
    async loadModel(name) {
        const assets = await this.assetsPromise, asset = assets.models[name];
        const key = new URL(`./model-cache/${asset.sha256}`, import.meta.url).href;
        let cache = null, bytes = null;
        try {
            cache = await caches.open('egc-classifier-models-v1');
            const response = await cache.match(key);
            if (response) {
                this.emit({type: 'stage', stage: `Verifying saved ${asset.name.toLowerCase()} model`});
                const candidate = await response.arrayBuffer();
                if (candidate.byteLength === asset.bytes && await hashBytes(candidate) === asset.sha256) { bytes = candidate; }
                else { await cache.delete(key); }
            }
        } catch (error) { this.emit({type: 'notice', message: 'Model storage is unavailable. This session can still run; models may download again next time.'}); }
        if (!bytes) {
            let url = asset.url;
            if (this.options.localModels && ['localhost', '127.0.0.1'].includes(location.hostname)) { url = `/__test_models/${asset.localName}`; }
            this.emit({type: 'download', name: asset.name, loaded: 0, total: asset.bytes});
            const response = await fetch(url, {referrerPolicy: 'no-referrer'});
            if (!response.ok || !response.body) { throw new Error(`Could not download ${asset.name.toLowerCase()} model. Check your connection and retry.`); }
            const reader = response.body.getReader(), parts = [];
            let length = 0, lastUpdate = 0;
            while (true) {
                const {value, done} = await reader.read();
                if (done) { break; }
                length += value.length;
                if (length > asset.bytes) { await reader.cancel(); throw new Error('Model download exceeds its verified size.'); }
                parts.push(value);
                if (performance.now() - lastUpdate > 120) {
                    this.emit({type: 'download', name: asset.name, loaded: length, total: asset.bytes}); lastUpdate = performance.now();
                }
            }
            const combined = new Uint8Array(length);
            let offset = 0;
            for (const part of parts) { combined.set(part, offset); offset += part.length; }
            parts.length = 0;
            bytes = combined.buffer;
            this.emit({type: 'stage', stage: `Checking ${asset.name.toLowerCase()} model`});
            if (length !== asset.bytes || await hashBytes(bytes) !== asset.sha256) { throw new Error('The model download did not pass its integrity check. Retry the download.'); }
            if (cache) {
                try { await cache.put(key, new Response(bytes, {headers: {'Content-Type': 'application/octet-stream'}})); }
                catch (error) { this.emit({type: 'notice', message: 'There is not enough browser storage to keep this model offline. Processing can continue.'}); }
            }
        }
        this.emit({type: 'stage', stage: `Loading ${asset.name.toLowerCase()} model`});
        const session = await ort.InferenceSession.create(new Uint8Array(bytes), {
            executionProviders: ['wasm'], graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false,
        });
        return session;
    }
    async audio(channels, rate) {
        const native = await this.native(), channel = strongestChannel(channels);
        let mono = channels[channel];
        if (rate !== 48000) {
            const ptr = native._malloc(mono.byteLength);
            try {
                native.HEAPF32.set(mono, ptr / 4);
                const length = native._toy_resample(ptr, mono.length, rate, 48000);
                const data = native._toy_resampled_data();
                mono = native.HEAPF32.slice(data / 4, data / 4 + length);
            } finally { native._free(ptr); }
        }
        const session = await this.model('audio'), filters = await this.filtersPromise;
        const maximum = 480000;
        const offsets = [...new Set([0, Math.max(0, Math.floor((mono.length - maximum) / 2)), Math.max(0, mono.length - maximum)])].sort((a, b) => a - b);
        const vectors = [];
        for (let crop = 0; crop < offsets.length; crop++) {
            this.emit({type: 'stage', stage: `Listening to sample${offsets.length > 1 ? ` (${crop + 1}/${offsets.length})` : ''}`});
            const part = mono.subarray(offsets[crop], offsets[crop] + maximum);
            let wave = part;
            if (part.length < maximum) {
                wave = new Float32Array(maximum);
                const repeats = Math.floor(maximum / part.length);
                for (let repeat = 0; repeat < repeats; repeat++) { wave.set(part, repeat * part.length); }
            }
            const features = spectrogram(wave, filters);
            const tensor = new ort.Tensor('float32', features.data, [1, 1, features.frames, 64]);
            let outputs;
            try {
                outputs = await session.run({input_features: tensor});
                const vector = Array.from(outputs.audio_embeds.data);
                const norm = Math.hypot(...vector);
                if (vector.length !== 512 || !Number.isFinite(norm) || norm <= 0 || vector.some(v => !Number.isFinite(v))) { throw new Error('Invalid audio embedding returned by the model.'); }
                vectors.push(vector.map(v => v / norm));
            } finally {
                tensor.dispose();
                if (outputs) { for (const value of Object.values(outputs)) { value.dispose(); } }
            }
        }
        let peak = 0;
        for (const value of channels[channel]) { peak = Math.max(peak, Math.abs(value)); }
        return {version: 1, frontend: FRONTEND, modelSha256: (await this.assetsPromise).models.audio.sha256,
            vectors, windowOffsets: offsets, peak, selectedChannel: channel,
            samples: channels[0].length, rate, channels: channels.length};
    }
    async scores(embedding) {
        const {names, vectors} = await this.prototypesPromise;
        const all = embedding.vectors.map(vector => vectors.map(prototype => prototype.reduce((sum, v, i) => sum + Math.fround(vector[i]) * Math.fround(v), 0)));
        return Object.fromEntries(names.map((name, index) => [name,
            all.reduce((sum, row) => sum + row[index], 0) / all.length * .5 + Math.max(...all.map(row => row[index])) * .5]));
    }
    async analyse(channels, rate, embeddedRoot = null, includeBeats = true) {
        const native = await this.native(), pointers = [];
        let handle = 0;
        try {
            for (const channel of channels) {
                const ptr = native._malloc(channel.byteLength);
                if (!ptr) { throw new Error('Audio is too large for available browser memory.'); }
                pointers.push(ptr); native.HEAPF32.set(channel, ptr / 4);
            }
            this.emit({type: 'stage', stage: 'Finding attacks, pitch and vocal starts'});
            handle = native._toy_analyse(pointers[0], pointers[1] || 0, channels.length, channels[0].length, rate);
            if (!handle) { throw new Error('Playable samples must be mono/stereo, 8–192 kHz and shorter than 60 seconds.'); }
            if (includeBeats) {
                const frames = native._toy_beat_features(handle);
                if (frames > 0) {
                    const at = native._toy_feature_data(handle);
                    const features = native.HEAPF32.slice(at / 4, at / 4 + frames * 128);
                    const predictions = await this.beats(features, frames);
                    const beatPtr = native._malloc(frames * 4), downbeatPtr = native._malloc(frames * 4);
                    try {
                        native.HEAPF32.set(predictions.beat, beatPtr / 4);
                        native.HEAPF32.set(predictions.downbeat, downbeatPtr / 4);
                        native._toy_apply_beats(handle, beatPtr, downbeatPtr, frames);
                    } finally { native._free(beatPtr); native._free(downbeatPtr); }
                }
            }
            return JSON.parse(native.UTF8ToString(native._toy_json(handle, embeddedRoot === null ? -1 : embeddedRoot)));
        } finally {
            if (handle) { native._toy_destroy(handle); }
            for (const ptr of pointers) { native._free(ptr); }
        }
    }
    async beats(features, frames) {
        const session = await this.model('beat'), starts = [], chunks = [];
        const size = 1500, border = 6, step = size - 2 * border;
        for (let start = -border; start < frames - border; start += step) { starts.push(start); }
        if (frames > step) { starts[starts.length - 1] = frames - (size - border); }
        for (let index = 0; index < starts.length; index++) {
            this.emit({type: 'stage', stage: `Finding loop beats (${index + 1}/${starts.length})`});
            const start = starts[index], begin = Math.max(0, start), end = Math.min(start + size, frames);
            const left = Math.max(0, -start), right = Math.max(0, Math.min(border, start + size - frames));
            const count = end - begin + left + right;
            const input = new Float32Array(count * 128);
            input.set(features.subarray(begin * 128, end * 128), left * 128);
            const tensor = new ort.Tensor('float32', input, [1, count, 128]);
            let outputs;
            try {
                outputs = await session.run({input_spectrogram: tensor});
                chunks.push({beat: Float32Array.from(outputs.beat.data), downbeat: Float32Array.from(outputs.downbeat.data)});
            } finally {
                tensor.dispose();
                if (outputs) { for (const value of Object.values(outputs)) { value.dispose(); } }
            }
        }
        const result = {beat: new Float32Array(frames).fill(-1000), downbeat: new Float32Array(frames).fill(-1000)};
        for (let index = chunks.length - 1; index >= 0; index--) {
            for (const name of ['beat', 'downbeat']) {
                const values = chunks[index][name];
                const first = values.length < 2 * border ? 0 : border;
                const last = values.length < 2 * border ? values.length : values.length - border;
                for (let i = first; i < last; i++) {
                    const target = starts[index] + i;
                    if (target >= 0 && target < frames) { result[name][target] = values[i]; }
                }
            }
        }
        return result;
    }
}
