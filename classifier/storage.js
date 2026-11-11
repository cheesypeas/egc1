const MAX_JSON = 64 * 1024 * 1024;
export const AUDIO_EXTENSION = /\.(wav|wave|aif|aiff|aifc|flac|ogg|mp3|m4a)$/i;

export function safeRelative(path) {
    if (typeof path !== 'string' || !path || path.includes('\\') || path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..')) {
        throw new Error('Invalid relative file path.');
    }
    return path;
}

export const METADATA = ".egc1";
export const LEGACY_METADATA = ".toysampler";
export const canonicalPath = path => path === LEGACY_METADATA || path.startsWith(LEGACY_METADATA + "/") ? METADATA + path.slice(LEGACY_METADATA.length) : path;

function migratePaths(value) {
    if (Array.isArray(value)) { return value.map(migratePaths); }
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, ["path", "sourcePath"].includes(key) && typeof item === "string" ? canonicalPath(item) : migratePaths(item)]));
    }
    return value;
}

export class Folder {
    constructor(handle, files = [], emit = () => {}) {
        this.handle = handle;
        this.files = new Map(files.map(({path, file}) => [safeRelative(path), file]));
        this.outputs = new Map();
        this.emit = emit;
        this.initialised = false;
        this.writeMilliseconds = 0;
        this.writeCount = 0;
    }
    async initialise({locked = false} = {}) {
        if (this.initialised) { return; }
        const rawFile = async path => {
            if (this.outputs.has(path)) { return this.outputs.get(path); }
            if (!this.handle) { return this.files.get(path) || null; }
            try { return await (await this.entry(path)).getFile(); }
            catch (error) { if (error.name === 'NotFoundError') { return null; } throw error; }
        };
        if (await rawFile('.egc1/library.json') || !await rawFile('.toysampler/library.json')) { this.initialised = true; return; }
        // Processing already holds this lock; review acquires it before copying legacy files.
        if (!locked && globalThis.navigator?.locks) {
            return navigator.locks.request('egc-classifier-write', () => this.initialise({locked:true}));
        }
        this.emit({type: 'stage', stage: 'Migrating legacy metadata to .egc1'});
        const legacy = [];
        if (this.handle) {
            const visit = async (directory, prefix) => {
                for await (const [name, entry] of directory.entries()) {
                    const path = prefix + name;
                    if (entry.kind === 'directory') { await visit(entry, path + '/'); }
                    else if (!name.endsWith('.lock') && !name.endsWith('.tmp')) { legacy.push({path, file: await entry.getFile()}); }
                }
            };
            await visit(await this.handle.getDirectoryHandle('.toysampler'), '.toysampler/');
        } else {
            for (const [path, file] of this.files) {
                if (path.startsWith('.toysampler/') && !path.endsWith('.lock') && !path.endsWith('.tmp')) { legacy.push({path, file}); }
            }
        }
        // Publish the catalogue last. A partial migration remains safely readable from legacy metadata.
        legacy.sort((a, b) => Number(a.path.endsWith('/library.json')) - Number(b.path.endsWith('/library.json')));
        for (const {path, file} of legacy) {
            if (path.endsWith('.json')) {
                const value = JSON.parse(await file.text());
                await this.writeJson(canonicalPath(path), migratePaths(value));
            } else { await this.write(canonicalPath(path), file); }
        }
        this.initialised = true;
        this.emit({type: 'notice', message: 'Metadata migrated to .egc1. The legacy folder is retained as a backup; new writes use .egc1.'});
    }
    async entry(path, create = false) {
        const parts = safeRelative(path).split('/');
        let directory = this.handle;
        for (const part of parts.slice(0, -1)) { directory = await directory.getDirectoryHandle(part, {create}); }
        return directory.getFileHandle(parts[parts.length - 1], {create});
    }
    async file(path) {
        safeRelative(path);
        path = canonicalPath(path);
        if (this.outputs.has(path)) { return this.outputs.get(path); }
        if (this.handle) { return (await this.entry(path)).getFile(); }
        return this.files.get(path) || null;
    }
    async json(path) {
        let file;
        try { file = await this.file(path); }
        catch (error) { if (error.name === 'NotFoundError') { return null; } throw error; }
        if (!file) { return null; }
        if (file.size > MAX_JSON) { throw new Error(`Metadata is too large: ${path}`); }
        try { return JSON.parse(await file.text()); }
        catch (error) { throw new Error(`Cannot read ${path}. Restore or move the damaged metadata before retrying.`); }
    }
    async write(path, value) {
        const started = performance.now();
        try {
            safeRelative(path);
            path = canonicalPath(path);
            if (!path.startsWith('.egc1/')) { throw new Error('Only .egc1 metadata and derived audio may be written.'); }
            const blob = value instanceof Blob ? value : new Blob([value]);
            if (this.handle) {
                // createWritable commits on close, retaining the old file until then.
                const file = await this.entry(path, true);
                const stream = await file.createWritable();
                try { await stream.write(blob); await stream.close(); }
                catch (error) { try { await stream.abort(); } catch (_) {} throw error; }
            } else {
                this.outputs.set(path, blob);
                this.emit({type: 'output', path, blob});
            }
        } finally {
            this.writeMilliseconds += performance.now() - started;
            this.writeCount++;
        }
    }
    async writeJson(path, value) { await this.write(path, new Blob([JSON.stringify(value, null, 2) + '\n'], {type: 'application/json'})); }
    async scan() {
        const files = [];
        const visit = async (directory, prefix = '') => {
            for await (const [name, entry] of directory.entries()) {
                if (name.startsWith('.') || name === '__MACOSX') { continue; }
                const path = prefix + name;
                if (entry.kind === 'directory') { await visit(entry, path + '/'); }
                else if (AUDIO_EXTENSION.test(name)) {
                    files.push({path, handle: entry});
                    if (files.length % 50 === 0) { this.emit({type: 'stage', stage: `Finding samples · ${files.length.toLocaleString()} found`}); }
                }
            }
        };
        if (this.handle) { await visit(this.handle); }
        else {
            for (const [path, file] of this.files) {
                if (AUDIO_EXTENSION.test(path) && !path.split('/').some(p => p.startsWith('.') || p === '__MACOSX')) { files.push({path, file}); }
            }
        }
        return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    }
}

export function validBanks(config) {
    const valid = config?.version === 1 && Array.isArray(config.banks) && config.banks.length === 3 &&
        config.banks.every((banks, mode) => Array.isArray(banks) && banks.length === 4 && banks.every(bank =>
            bank && typeof bank.label === 'string' && (bank.kind === 'samples' || (mode === 0 && bank.kind === 'kits')) &&
            ['tagsAny', 'tagsAll', 'exclude'].every(field => bank[field] === undefined ||
                (Array.isArray(bank[field]) && bank[field].every(tag => typeof tag === 'string' && /^[a-z0-9-]+$/.test(tag))))));
    if (!valid) { throw new Error('Existing banks.json is invalid. Repair it before preparing this folder; its bank configuration has been left untouched.'); }
    return config;
}

export function validOverrides(value) {
    if (value === null) { return {}; }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([id, tags]) =>
        !/^[0-9a-f]{64}$/.test(id) || !Array.isArray(tags) || !tags.length || tags.some(tag => typeof tag !== 'string' || !/^[a-z0-9-]+$/.test(tag)))) {
        throw new Error('Invalid overrides.json. Existing manual classifications have been left untouched.');
    }
    return value;
}

export function validAnalysis(data, id, pipeline, info) {
    if (!data || data.version !== 1 || data.id !== id || data.pipeline !== pipeline || data.channels !== info.channels) { return false; }
    for (const [name, version] of [['pitch', 5], ['loop', 8], ['vocal', 2]]) {
        const item = data[name];
        if (!item || item.version !== 1 || item.analysisVersion !== version || item.samples !== info.frames || item.rate !== info.rate ||
            !Number.isFinite(item.root) || item.root < 0 || item.root > 127 || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1.00001) { return false; }
        for (const field of ['transients', ...(name === 'pitch' ? [] : ['beats', 'downbeats']), ...(name === 'vocal' ? ['vocalStarts', 'vocalDefaults'] : [])]) {
            const values = item[field];
            if (!Array.isArray(values) || values.length > 10000 || values.some((v, i) => !Number.isInteger(v) || v < 0 || v >= info.frames || (i && values[i - 1] >= v))) { return false; }
        }
        const starts = name === 'vocal' ? item.vocalStarts : item.transients;
        if (name === 'vocal' && (!starts.length || !item.vocalDefaults.length || item.vocalDefaults.length > 8 || item.vocalDefaults.some(v => !starts.includes(v)))) { return false; }
        if (item.gateVersion !== 1 || JSON.stringify(item.gateStarts) !== JSON.stringify(starts) ||
            !Array.isArray(item.gateStrengths) || item.gateStrengths.length !== starts.length || item.gateStrengths.some(v => !Number.isFinite(v) || v < 0 || v > 1)) { return false; }
    }
    return true;
}

export function validEmbedding(item, id, info, frontend, model) {
    return item && item.version === 1 && item.id === id && item.frontend === frontend && item.modelSha256 === model &&
        item.rate === info.rate && item.samples === info.frames && item.channels === info.channels &&
        Number.isFinite(item.peak) && item.peak >= 0 && Array.isArray(item.vectors) && item.vectors.length >= 1 && item.vectors.length <= 3 &&
        item.vectors.every(v => Array.isArray(v) && v.length === 512 && v.every(Number.isFinite) && Math.abs(Math.hypot(...v) - 1) < .001);
}

const crcTable = Uint32Array.from({length: 256}, (_, value) => {
    for (let bit = 0; bit < 8; bit++) { value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; }
    return value >>> 0;
});

// A store-only ZIP avoids a compression dependency and preserves exported bytes.
export async function metadataZip(outputs, progress = () => {}) {
    const parts = [], directory = [], encoder = new TextEncoder();
    let offset = 0, index = 0;
    for (const [path, blob] of outputs) {
        safeRelative(path);
        if (blob.size > 0xffffffff || offset + blob.size > 0xffffffff) { throw new Error('This export is too large for ZIP. Use direct folder saving in Chrome or Edge.'); }
        const name = encoder.encode(path), bytes = new Uint8Array(await blob.arrayBuffer());
        let crc = 0xffffffff;
        for (const value of bytes) { crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8); }
        crc = (crc ^ 0xffffffff) >>> 0;
        const header = new Uint8Array(30 + name.length), view = new DataView(header.buffer);
        view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x800, true);
        view.setUint32(14, crc, true); view.setUint32(18, blob.size, true); view.setUint32(22, blob.size, true); view.setUint16(26, name.length, true); header.set(name, 30);
        const central = new Uint8Array(46 + name.length), c = new DataView(central.buffer);
        c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true);
        c.setUint32(16, crc, true); c.setUint32(20, blob.size, true); c.setUint32(24, blob.size, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true); central.set(name, 46);
        parts.push(header, blob); directory.push(central); offset += header.length + blob.size;
        progress(++index / outputs.size);
    }
    if (directory.length > 65535) { throw new Error('Too many files for this ZIP export. Use direct folder saving.'); }
    const size = directory.reduce((sum, p) => sum + p.length, 0), end = new Uint8Array(22), e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, directory.length, true); e.setUint16(10, directory.length, true);
    e.setUint32(12, size, true); e.setUint32(16, offset, true);
    return new Blob([...parts, ...directory, end], {type: 'application/zip'});
}
