import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {SHA256, hashFile, audioInfo, encodeWav, readWav, strongestChannel, energyEnvelope, splitEnvelope} from '../audio.js';
import {Folder, metadataZip, validOverrides, validBanks} from '../storage.js';
import {nameHints, applyHints, classifyScores, FAMILIES, BANKS} from '../taxonomy.js';

test('streaming identities match SHA-256 across blocks, padding boundaries and large files', async () => {
    for (const size of [0, 1, 55, 56, 63, 64, 65, 10000, 4 * 1024 * 1024 + 513]) {
        const bytes = randomBytes(size), expected = createHash('sha256').update(bytes).digest('hex');
        const hash = new SHA256();
        for (let at = 0; at < size; at += 57) { hash.update(bytes.subarray(at, at + 57)); }
        assert.equal(hash.hex(), expected);
        assert.equal(await hashFile(new Blob([bytes])), expected);
    }
});
test('derived 24-bit audio preserves channel geometry and samples to one quantisation step', async () => {
    const channels = [Float32Array.from([-1, -.3, 0, .3, .99999]), Float32Array.from([.5, 0, -.5, 1, -.99999])];
    const file = new Blob([encodeWav(channels, 44100)]), info = await audioInfo(file);
    assert.equal(info.rate, 44100); assert.equal(info.channels, 2); assert.equal(info.frames, 5);
    const read = await readWav(file, info);
    for (let ch = 0; ch < 2; ch++) { for (let i = 0; i < 5; i++) { assert.ok(Math.abs(read[ch][i] - channels[ch][i]) <= 1 / 8388608); } }
    const odd = new Blob([encodeWav([new Float32Array(3)], 48000)]);
    assert.equal(odd.size % 2, 0); assert.equal((await audioInfo(odd)).frames, 3);
    const region = await readWav(file, info, 1, 4);
    assert.equal(region[0].length, 3); assert.ok(Math.abs(region[0][0] + .3) < 1e-6);
});
test('antiphase stereo stays audible and long silence separates two ordinary sounds', () => {
    const rate = 48000, left = new Float32Array(rate * 2);
    for (let i = 0; i < left.length; i++) { if ((i > 2000 && i < 8000) || (i > 52000 && i < 58000)) { left[i] = Math.sin(i * .04) * .7; } }
    const right = Float32Array.from(left, v => -v);
    assert.equal(strongestChannel([left, right]), 0);
    const result = splitEnvelope(energyEnvelope([left, right], 240), left.length, rate);
    assert.equal(result.split, true); assert.equal(result.bounds.length, 2);
    assert.ok(result.bounds[0].start <= 2000 && result.bounds[0].end >= 8000);
    assert.ok(result.bounds[1].start <= 52000 && result.bounds[1].end >= 58000);
});
test('folder writes cannot escape metadata or overwrite source audio', async () => {
    const folder = new Folder(null, [], () => {});
    for (const path of ['original.wav', '../oops', '/absolute', '.toysampler/../original.wav', '.toysampler/evil\\path']) {
        await assert.rejects(folder.write(path, new Blob(['x'])));
    }
    await folder.writeJson('.toysampler/overrides.json', {});
    assert.deepEqual(await folder.json('.toysampler/overrides.json'), {});
    assert.throws(() => validOverrides({'../bad': ['drums']}));
});
test('ZIP exports contain metadata under the expected relative names', async () => {
    const path = '.toysampler/regions/café.wav';
    const blob = await metadataZip(new Map([[path, new Blob(['audio'])], ['.toysampler/library.json', new Blob(['{}'])]]));
    const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer);
    assert.equal(view.getUint32(0, true), 0x04034b50);
    assert.equal(view.getUint16(6, true), 0x800);
    assert.equal(new TextDecoder().decode(bytes.subarray(30, 30 + view.getUint16(26, true))), path);
    assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50);
    assert.equal(view.getUint16(bytes.length - 12, true), 2);
});
test('hints are token based, manual-quality roles remain specific, and isolated hits do not become loops', () => {
    assert.deepEqual(nameHints('Synth/Warm Pads_07.wav'), ['synth', 'pad']);
    assert.deepEqual(nameHints('assorted/bassoon.wav'), []);
    assert.deepEqual(applyHints(['synth', 'keys'], ['synth', 'pad']), ['synth', 'pad']);
    const scores = Object.fromEntries([...Object.values(FAMILIES).flat(), 'silence'].map(key => [key, .01]));
    scores['drum-loop'] = .5; scores.kick = .4;
    assert.deepEqual(classifyScores(scores, .5, {transients: [0, 50], rate: 48000}).tags, ['drums', 'kick']);
    assert.deepEqual(classifyScores(scores, 2, {transients: [0, 24000, 48000, 72000], rate: 48000}).tags, ['loops', 'drum-loop']);
    assert.deepEqual(classifyScores(scores, 2, {}, 'hit').tags, ['drums', 'kick']);
});

test('CLAP mel features match the native Transformers frontend reference', async () => {
    const {readFile} = await import('node:fs/promises');
    const {spectrogram} = await import('../audio.js');
    const filters = JSON.parse(await readFile(new URL('../mel-filters.json', import.meta.url), 'utf8'));
    const golden = JSON.parse(await readFile(new URL('./clap-frontend-golden.json', import.meta.url), 'utf8'));
    const wave = Float32Array.from({length: 480000}, (_, i) => ((i * 37) % 2048 - 1024) / 1024);
    const result = spectrogram(wave, filters);
    assert.equal(result.frames, golden.shape[0]);
    for (const [frame, band, expected] of golden.points) {
        const actual = result.data[frame * 64 + band];
        assert.ok(Math.abs(actual - expected) < .0002, `frame ${frame}, band ${band}: ${actual} vs ${expected}`);
    }
});


test('bank configurations preserve the instrument schema and recorded vocal routing', () => {
    assert.equal(validBanks(BANKS), BANKS);
    assert.throws(() => validBanks({...BANKS, version: 2}));
    const invalid = structuredClone(BANKS); invalid.banks[1][0].kind = 'kits';
    assert.throws(() => validBanks(invalid));
    assert.ok(BANKS.banks[1][3].tagsAny.includes('vocal'));
    assert.ok(BANKS.banks[2][3].tagsAny.includes('vocal-note'));
});
