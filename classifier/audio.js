// Browser audio primitives. No network, model, or UI work happens here.
export class SHA256 {
    constructor() {
        this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
        this.buffer = new Uint8Array(64);
        this.w = new Uint32Array(64);
        this.used = 0;
        this.bytes = 0;
    }
    block(data, offset = 0) {
        const k = SHA256.k;
        const w = this.w;
        for (let i = 0; i < 16; i++) {
            const p = offset + i * 4;
            w[i] = (data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3];
        }
        const r = (x, n) => (x >>> n) | (x << (32 - n));
        for (let i = 16; i < 64; i++) {
            const a = w[i - 15], b = w[i - 2];
            w[i] = w[i - 16] + (r(a, 7) ^ r(a, 18) ^ (a >>> 3)) + w[i - 7] + (r(b, 17) ^ r(b, 19) ^ (b >>> 10));
        }
        let [a, b, c, d, e, f, g, h] = this.h;
        for (let i = 0; i < 64; i++) {
            const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i]) >>> 0;
            const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
            h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        [a, b, c, d, e, f, g, h].forEach((v, i) => { this.h[i] = (this.h[i] + v) >>> 0; });
    }
    update(data) {
        this.bytes += data.length;
        let at = 0;
        if (this.used) {
            const n = Math.min(64 - this.used, data.length);
            this.buffer.set(data.subarray(0, n), this.used);
            this.used += n; at += n;
            if (this.used === 64) { this.block(this.buffer); this.used = 0; }
        }
        while (at + 64 <= data.length) { this.block(data, at); at += 64; }
        this.buffer.set(data.subarray(at), this.used);
        this.used += data.length - at;
        return this;
    }
    hex() {
        const length = this.bytes * 8;
        this.buffer[this.used++] = 128;
        if (this.used > 56) { this.buffer.fill(0, this.used); this.block(this.buffer); this.used = 0; }
        this.buffer.fill(0, this.used, 56);
        const view = new DataView(this.buffer.buffer);
        view.setUint32(56, Math.floor(length / 4294967296));
        view.setUint32(60, length >>> 0);
        this.block(this.buffer);
        return Array.from(this.h, v => v.toString(16).padStart(8, '0')).join('');
    }
}
SHA256.k = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);

export async function hashFile(file, progress = () => {}) {
    const hash = new SHA256();
    for (let at = 0; at < file.size; at += 4 * 1024 * 1024) {
        hash.update(new Uint8Array(await file.slice(at, at + 4 * 1024 * 1024).arrayBuffer()));
        progress(Math.min(1, (at + 4 * 1024 * 1024) / file.size));
    }
    return hash.hex();
}

export async function hashBytes(bytes) {
    const raw = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)), v => v.toString(16).padStart(2, '0')).join('');
}

const text = (view, at, n) => String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + at, n));

export async function wavInfo(file) {
    const header = new DataView(await file.slice(0, 12).arrayBuffer());
    if (header.byteLength !== 12 || text(header, 0, 4) !== 'RIFF' || text(header, 8, 4) !== 'WAVE') {
        throw new Error('Use a standard PCM/float WAV file; this WAV container is not supported.');
    }
    let format = null, data = null, root = null;
    for (let offset = 12; offset + 8 <= file.size;) {
        const chunk = new DataView(await file.slice(offset, offset + 8).arrayBuffer());
        const name = text(chunk, 0, 4), size = chunk.getUint32(4, true);
        if (offset + 8 + size > file.size) { throw new Error('Truncated WAV chunk.'); }
        if (name === 'fmt ') {
            const fmt = new DataView(await file.slice(offset + 8, offset + 8 + Math.min(size, 64)).arrayBuffer());
            if (fmt.byteLength < 16) { throw new Error('Incomplete WAV format.'); }
            let type = fmt.getUint16(0, true);
            if (type === 65534 && fmt.byteLength >= 40) { type = fmt.getUint16(24, true); }
            format = {type, channels: fmt.getUint16(2, true), rate: fmt.getUint32(4, true), stride: fmt.getUint16(12, true), bits: fmt.getUint16(14, true)};
        } else if (name === 'data' && data === null) {
            data = {offset: offset + 8, bytes: size};
        } else if (name === 'smpl' && size >= 36) {
            const smpl = new DataView(await file.slice(offset + 8, offset + 44).arrayBuffer());
            const midi = smpl.getUint32(12, true) + smpl.getUint32(16, true) / 4294967296;
            if (midi >= 0 && midi <= 127) { root = midi; }
        }
        offset += 8 + size + size % 2;
    }
    if (!format || !data || ![1, 3].includes(format.type) || ![1, 2].includes(format.channels) ||
        ![8, 16, 24, 32, 64].includes(format.bits) || (format.type === 3 && ![32, 64].includes(format.bits)) ||
        (format.type === 1 && format.bits === 64) || format.stride !== format.channels * format.bits / 8 ||
        format.rate < 8000 || format.rate > 192000 || data.bytes % format.stride) {
        throw new Error('WAV must be mono/stereo, 8–192 kHz, and use PCM or floating-point samples.');
    }
    const frames = data.bytes / format.stride;
    if (!frames || frames / format.rate > 21600) { throw new Error('Empty WAV or source longer than six hours.'); }
    return {...format, ...data, frames, root};
}

export async function readWav(file, info, start = 0, end = info.frames) {
    if (end <= start || start < 0 || end > info.frames) { throw new Error('Invalid audio region.'); }
    const raw = new DataView(await file.slice(info.offset + start * info.stride, info.offset + end * info.stride).arrayBuffer());
    const channels = Array.from({length: info.channels}, () => new Float32Array(end - start));
    const bytes = info.bits / 8, little = info.little !== false;
    for (let frame = 0; frame < end - start; frame++) {
        for (let ch = 0; ch < channels.length; ch++) {
            const at = frame * info.stride + ch * bytes;
            let value;
            if (info.type === 3) { value = info.bits === 32 ? raw.getFloat32(at, little) : raw.getFloat64(at, little); }
            else if (info.bits === 8) { value = info.signed8 ? raw.getInt8(at) / 128 : (raw.getUint8(at) - 128) / 128; }
            else if (info.bits === 16) { value = raw.getInt16(at, little) / 32768; }
            else if (info.bits === 24) {
                const integer = little ? raw.getUint8(at) | (raw.getUint8(at + 1) << 8) | (raw.getUint8(at + 2) << 16) :
                    raw.getUint8(at + 2) | (raw.getUint8(at + 1) << 8) | (raw.getUint8(at) << 16);
                value = (integer << 8 >> 8) / 8388608;
            } else { value = raw.getInt32(at, little) / 2147483648; }
            if (!Number.isFinite(value)) { throw new Error('Audio contains NaN or infinite samples.'); }
            channels[ch][frame] = value;
        }
    }
    return channels;
}

export async function audioInfo(file) {
    const header = new DataView(await file.slice(0, Math.min(file.size, 65536)).arrayBuffer());
    if (header.byteLength < 12) { throw new Error('Audio file is empty or truncated.'); }
    const magic = text(header, 0, 4);
    if (magic === 'RIFF') { return wavInfo(file); }
    if (magic === 'FORM' && ['AIFF', 'AIFC'].includes(text(header, 8, 4))) {
        let format = null, data = null;
        for (let offset = 12; offset + 8 <= file.size;) {
            const view = new DataView(await file.slice(offset, offset + 8).arrayBuffer());
            const name = text(view, 0, 4), size = view.getUint32(4);
            if (offset + 8 + size > file.size) { throw new Error('Truncated AIFF chunk.'); }
            if (name === 'COMM') {
                const v = new DataView(await file.slice(offset + 8, offset + 8 + Math.min(size, 32)).arrayBuffer());
                if (v.byteLength < 18) { throw new Error('Incomplete AIFF format.'); }
                const exponent = v.getUint16(8), mantissa = v.getUint32(10) * 4294967296 + v.getUint32(14);
                const rate = mantissa * Math.pow(2, (exponent & 32767) - 16383 - 63) * (exponent & 32768 ? -1 : 1);
                const compression = v.byteLength >= 22 ? text(v, 18, 4) : 'NONE';
                if (!['NONE', 'twos', 'sowt', 'fl32', 'FL32', 'fl64', 'FL64'].includes(compression)) { throw new Error('This compressed AIFF is not supported. Convert it to PCM WAV.'); }
                format = {channels: v.getUint16(0), frames: v.getUint32(2), bits: v.getUint16(6), rate,
                    type: /fl/i.test(compression) ? 3 : 1, little: compression === 'sowt', signed8: true, root: null};
                format.stride = format.channels * format.bits / 8;
            } else if (name === 'SSND' && size >= 8) {
                const v = new DataView(await file.slice(offset + 8, offset + 16).arrayBuffer());
                const shift = v.getUint32(0);
                data = {offset: offset + 16 + shift, bytes: size - 8 - shift};
            }
            offset += 8 + size + size % 2;
        }
        if (!format || !data || ![1, 2].includes(format.channels) || ![8, 16, 24, 32, 64].includes(format.bits) ||
            (format.type === 3 && ![32, 64].includes(format.bits)) || (format.type === 1 && format.bits === 64) ||
            !Number.isInteger(format.rate) || format.rate < 8000 || format.rate > 192000 || !format.frames ||
            format.frames > format.rate * 21600 || data.bytes < format.frames * format.stride) { throw new Error('AIFF must be mono/stereo, 8–192 kHz PCM or floating point.'); }
        return {...format, ...data};
    }
    if (magic === 'fLaC' && header.byteLength >= 42 && (header.getUint8(4) & 127) === 0) {
        const packed = (BigInt(header.getUint32(18)) << 32n) | BigInt(header.getUint32(22));
        const rate = Number(packed >> 44n), channels = Number((packed >> 41n) & 7n) + 1, frames = Number(packed & ((1n << 36n) - 1n));
        if (rate < 8000 || rate > 192000 || channels > 2 || !frames) { throw new Error('FLAC must be mono/stereo, 8–192 kHz.'); }
        return {compressed: true, rate, channels, frames, root: null};
    }
    if (magic === 'OggS') {
        const bytes = new Uint8Array(header.buffer);
        for (let at = 0; at + 16 < bytes.length; at++) {
            if (bytes[at] === 1 && text(header, at + 1, 6) === 'vorbis') {
                const rate = header.getUint32(at + 12, true), channels = bytes[at + 11];
                if (rate < 8000 || rate > 192000 || ![1, 2].includes(channels)) { throw new Error('Ogg must be mono/stereo, 8–192 kHz.'); }
                return {compressed: true, rate, channels, frames: null, root: null};
            }
        }
    }
    throw new Error('Use WAV, AIFF, FLAC or Ogg Vorbis. This audio format is not supported by the sampler.');
}

export function encodeWav(channels, rate) {
    const frames = channels[0].length, count = channels.length;
    const dataBytes = frames * count * 3;
    const bytes = new Uint8Array(44 + dataBytes + (dataBytes & 1));
    const view = new DataView(bytes.buffer);
    const word = (at, value) => { for (let i = 0; i < value.length; i++) { bytes[at + i] = value.charCodeAt(i); } };
    word(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); word(8, 'WAVE'); word(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, count, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * count * 3, true);
    view.setUint16(32, count * 3, true); view.setUint16(34, 24, true); word(36, 'data'); view.setUint32(40, dataBytes, true);
    for (let i = 0, at = 44; i < frames; i++) {
        for (let ch = 0; ch < count; ch++, at += 3) {
            const value = Math.round(Math.max(-1, Math.min(8388607 / 8388608, channels[ch][i])) * 8388608);
            bytes[at] = value; bytes[at + 1] = value >> 8; bytes[at + 2] = value >> 16;
        }
    }
    return bytes;
}

export function strongestChannel(channels) {
    const energy = channels.map(channel => channel.reduce((sum, value) => sum + value * value, 0));
    return energy.indexOf(Math.max(...energy));
}

export function energyEnvelope(channels, hop) {
    const result = new Float32Array(Math.ceil(channels[0].length / hop));
    for (let at = 0, bin = 0; at < channels[0].length; at += hop, bin++) {
        const end = Math.min(channels[0].length, at + hop);
        let max = 0;
        for (const channel of channels) {
            let power = 0;
            for (let i = at; i < end; i++) { power += channel[i] * channel[i]; }
            max = Math.max(max, Math.sqrt(power / (end - at)));
        }
        result[bin] = max;
    }
    return result;
}

export function splitEnvelope(envelope, frames, rate) {
    const sorted = Float32Array.from(envelope).sort();
    const peak = sorted[sorted.length - 1];
    const threshold = Math.max(.00003, peak * .003162278, Math.min(sorted[Math.floor(sorted.length / 10)] * 2, peak * .03162278));
    const hop = Math.max(1, Math.floor(rate * .005));
    const bounds = [];
    const add = (start, end) => {
        if (end - start >= Math.floor(rate * .025)) { bounds.push({start: Math.max(0, start - Math.floor(rate * .02)), end: Math.min(frames, end + Math.floor(rate * .05))}); }
    };
    let cursor = 0;
    for (let bin = 0; bin < envelope.length;) {
        if (envelope[bin] > threshold) { bin++; continue; }
        const start = bin * hop;
        while (bin < envelope.length && envelope[bin] <= threshold) { bin++; }
        const end = Math.min(frames, bin * hop);
        if (end - start >= Math.floor(rate * .35)) { add(cursor, start); cursor = end; }
    }
    add(cursor, frames);
    return {bounds, threshold, split: bounds.length > 1 || frames >= rate * 60};
}

export async function scanWavRegions(file, info, progress = () => {}) {
    const hop = Math.max(1, Math.floor(info.rate * .005));
    const envelope = new Float32Array(Math.ceil(info.frames / hop));
    const size = hop * 512;
    for (let at = 0; at < info.frames; at += size) {
        const channels = await readWav(file, info, at, Math.min(info.frames, at + size));
        envelope.set(energyEnvelope(channels, hop), at / hop);
        progress(Math.min(1, (at + size) / info.frames));
    }
    return splitEnvelope(envelope, info.frames, info.rate);
}

export class FFT {
    constructor(size) {
        this.size = size;
        this.real = new Float64Array(size); this.imag = new Float64Array(size);
        this.reverse = new Uint32Array(size);
        const bits = Math.log2(size);
        for (let i = 0; i < size; i++) {
            let value = i, reversed = 0;
            for (let j = 0; j < bits; j++) { reversed = reversed * 2 + (value & 1); value >>>= 1; }
            this.reverse[i] = reversed;
        }
        this.cos = Float64Array.from({length: size / 2}, (_, i) => Math.cos(-2 * Math.PI * i / size));
        this.sin = Float64Array.from({length: size / 2}, (_, i) => Math.sin(-2 * Math.PI * i / size));
    }
    transform(input) {
        const {size, real, imag, reverse, cos, sin} = this;
        for (let i = 0; i < size; i++) { real[i] = input[reverse[i]]; imag[i] = 0; }
        for (let width = 2; width <= size; width *= 2) {
            const half = width / 2, step = size / width;
            for (let begin = 0; begin < size; begin += width) {
                for (let j = 0; j < half; j++) {
                    const a = begin + j, b = a + half;
                    const re = real[b] * cos[j * step] - imag[b] * sin[j * step];
                    const im = real[b] * sin[j * step] + imag[b] * cos[j * step];
                    real[b] = real[a] - re; imag[b] = imag[a] - im;
                    real[a] += re; imag[a] += im;
                }
            }
        }
        return this;
    }
}

// Both model frontends use a centred, reflect-padded periodic Hann STFT.
export function spectrogram(wave, filters, {hop = 480, beat = false} = {}) {
    const size = 1024, half = size / 2;
    const fft = new FFT(size), input = new Float64Array(size), bins = new Float64Array(half + 1);
    const window = Float64Array.from({length: size}, (_, i) => beat ? Math.fround(.5 * (1 - Math.cos(2 * Math.PI * i / size))) : .5 * (1 - Math.cos(2 * Math.PI * i / size)));
    const frames = 1 + Math.floor(wave.length / hop);
    const output = new Float32Array(frames * filters.length);
    const reflect = index => {
        const period = Math.max(1, 2 * wave.length - 2);
        index = ((index % period) + period) % period;
        return index < wave.length ? index : period - index;
    };
    for (let frame = 0; frame < frames; frame++) {
        for (let i = 0; i < size; i++) {
            const value = wave[reflect(frame * hop + i - half)] * window[i];
            input[i] = beat ? Math.fround(value) : value;
        }
        fft.transform(input);
        for (let bin = 0; bin <= half; bin++) {
            const re = Math.fround(fft.real[bin]), im = Math.fround(fft.imag[bin]);
            const power = re * re + im * im;
            bins[bin] = beat ? Math.sqrt(power) / 32 : power;
        }
        for (let band = 0; band < filters.length; band++) {
            const filter = filters[band];
            let value = 0;
            for (let i = 0; i < filter.length; i += 2) { value += bins[filter[i]] * filter[i + 1]; }
            output[frame * filters.length + band] = beat ? Math.log1p(1000 * Math.max(1e-10, value)) : 10 * Math.log10(Math.max(1e-10, value));
        }
    }
    return {data: output, frames};
}
