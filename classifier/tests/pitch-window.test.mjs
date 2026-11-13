import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import createAnalysis from '../vendor/analysis.mjs';

const native = await createAnalysis({wasmBinary:await readFile(new URL('../vendor/analysis.wasm', import.meta.url))});
const tone = (root, rate, seconds = 1) => Float32Array.from({length:Math.round(rate * seconds)}, (_, i) =>
    .4 * Math.sin(i * 2 * Math.PI * 440 * 2 ** ((root - 69) / 12) / rate));
function pitch(audio, rate, embeddedRoot = -1, channels = 1) {
    const pointer = native._malloc(audio.byteLength);
    try {
        native.HEAPF32.set(audio, pointer / 4);
        return JSON.parse(native.UTF8ToString(native._toy_pitch(pointer, channels, audio.length, rate, embeddedRoot)));
    } finally { native._free(pointer); }
}

test('low bass through fractional lead pitches survive file sample-rate changes', () => {
    for (const rate of [8000, 44100, 48000, 96000, 192000]) {
        for (const root of [24, 33, 45, 60, 69.23]) {
            for (const seconds of [.25, 1, 2]) {
                const result = pitch(tone(root, rate, seconds), rate);
                assert(result.pitch.hasRoot, `root ${root} at ${rate} Hz for ${seconds} s must be detected`);
                assert(Math.abs(result.pitch.root - root) < .06, `root ${root} at ${rate} Hz must retain octave and cents`);
                assert.equal(result.pitch.analysisVersion, 5, 'deployed instrument compatibility');
                assert.equal(result.pitch.analysisImplementation, 'toysampler-wasm-v3-rate-aware-pitch');
                assert.deepEqual(result.pitch, result.acousticPitch);
            }
        }
    }
});

test('embedded playback tuning stays separate from the measured acoustic root', () => {
    const result = pitch(tone(24, 192000), 192000, 64.25, 2);
    assert.equal(result.pitch.root, 64.25);
    assert.equal(result.pitch.confidence, 1);
    assert(Math.abs(result.acousticPitch.root - 24) < .06);
});

test('silence, noise, changing melodies and insufficient audio do not acquire confident roots', () => {
    for (const rate of [48000, 96000, 192000]) {
        assert(!pitch(new Float32Array(rate), rate).pitch.hasRoot);
        assert(!pitch(tone(24, rate, .001), rate).pitch.hasRoot);
        let seed = 1234;
        const noise = Float32Array.from({length:rate}, () => { seed = (1664525 * seed + 1013904223) >>> 0; return (seed / 4294967296 - .5) * .8; });
        assert(!pitch(noise, rate).pitch.hasRoot);
        const melody = new Float32Array(rate * 2);
        melody.set(tone(60, rate), 0); melody.set(tone(64, rate), rate);
        assert(!pitch(melody, rate).pitch.hasRoot, 'two notes have no single sample root');
    }
});

test('pitch-only cache refresh agrees with full analysis without changing source PCM', () => {
    const audio = tone(24, 192000), original = audio.slice(), result = pitch(audio, 192000);
    const pointer = native._malloc(audio.byteLength);
    let handle = 0;
    try {
        native.HEAPF32.set(audio, pointer / 4);
        handle = native._toy_analyse(pointer, 0, 1, audio.length, 192000);
        const full = JSON.parse(native.UTF8ToString(native._toy_json(handle, -1)));
        assert.deepEqual(full.pitch, result.pitch);
        assert.deepEqual(full.acousticPitch, result.acousticPitch);
        assert.deepEqual(audio, original);
    } finally { if (handle) { native._toy_destroy(handle); } native._free(pointer); }
});
