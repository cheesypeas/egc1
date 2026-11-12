import {Inference, PIPELINE} from '../inference.js';
import {validAnalysis} from '../storage.js';

export async function checkAnalysis() {
    const check = (condition, message) => { if (!condition) { throw new Error(message); } };
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const inference = new Inference(() => {});
    const rate = 48000, left = new Float32Array(rate), right = new Float32Array(rate);
    for (const at of [1000, 13000, 25000, 37000]) {
        for (let i = 0; i < 1800; i++) {
            const value = .4 * Math.exp(-i / 300) * Math.sin(i * .21);
            left[at + i] = value;
            right[at + 4000 + i] = -2 * value;
        }
    }
    let captured = [];
    // Exercise the real WASM beat frontend and postprocessor without a model download.
    inference.beats = async (features, frames) => {
        captured.push(Array.from(features));
        return {beat: new Float32Array(frames).fill(-1000), downbeat: new Float32Array(frames).fill(-1000)};
    };
    const mono = await inference.analyse([left], rate);
    const stereo = await inference.analyse([left, right], rate);
    check(stereo.channels === 2 && mono.channels === 1, 'Source channel metadata must be preserved');
    check(captured.length === 2 && captured[0].length > 0 && same(captured[0], captured[1]), 'Beat frontend must use left only');
    for (const [role, version] of [['pitch', 5], ['loop', 8], ['vocal', 2]]) {
        check(stereo[role].analysisVersion === version, `Wrong ${role} analysis version`);
        check(same(mono[role], stereo[role]), `Right-channel attacks changed ${role} analysis`);
        check(same(stereo[role].gateStarts, role === 'vocal' ? stereo[role].vocalStarts : stereo[role].transients), 'Gate and chops must share cuts');
        for (const at of stereo[role].gateStarts) {
            check(left[at] === 0, 'Isolated attacks must open at the preceding zero');
        }
    }
    check(stereo.loop.transients.length >= 4, 'Fixture must contain detected attacks');
    const silentLeft = await inference.analyse([new Float32Array(rate), right], rate, null, false);
    check(silentLeft.loop.transients.length === 0 && !silentLeft.pitch.hasRoot, 'Right-only sound must not create audible cuts or pitch');

    const tone = Float32Array.from({length: rate}, (_, i) => .2 * Math.sin(2 * Math.PI * 440 * i / rate));
    const other = Float32Array.from({length: rate}, (_, i) => .9 * Math.sin(2 * Math.PI * 880 * i / rate));
    const pitch = await inference.analyse([tone, other], rate, null, false);
    check(pitch.pitch.hasRoot && Math.abs(pitch.pitch.root - 69) < .1, 'Louder right channel must not replace left pitch');

    const before=captured.length;
    const sparse=await inference.analyse([tone],rate,null,true,{sequenceOnly:true});
    check(captured.length===before && sparse.browserBeatPolicy?.reason==='no-event-sequence', 'An unnamed sustained note must not run the beat frontend/model');
    const sequence=await inference.analyse([left],rate,null,true,{sequenceOnly:true});
    check(captured.length===before+1 && !sequence.browserBeatPolicy?.skipped, 'Original event sequences retain full beat analysis');
    check(same(sequence.loop,mono.loop), 'Selective timing must preserve the full loop analysis');
    const native=await inference.native(),frontend=native._toy_beat_features;
    let frontendCalls=0;
    native._toy_beat_features=(...args)=>{frontendCalls++;return frontend(...args);};
    const explicit=await inference.analyse([tone],rate,null,true);
    native._toy_beat_features=frontend;
    check(frontendCalls===1 && !explicit.browserBeatPolicy?.skipped, 'An explicit loop retains the full timing frontend even without four detected attacks');

    const id = 'a'.repeat(64), info = {channels: 2, rate, frames: rate};
    const data = {...stereo, id, pipeline: PIPELINE};
    check(validAnalysis(data, id, PIPELINE, info), 'Fresh analysis must be reusable');
    check(!validAnalysis({...data, pipeline: 'browser-library-1:core-8891981:frontend-r8brain-v1'}, id, PIPELINE, info), 'Old pipeline must be refreshed');
    for (const [role, version] of [['pitch', 2], ['loop', 7], ['vocal', 1]]) {
        const stale = structuredClone(data);
        stale[role].analysisVersion = version;
        check(!validAnalysis(stale, id, PIPELINE, info), `Old ${role} markers must be refreshed`);
    }
    return 'PASS: real WASM left-channel pitch/cuts/beats, selective loop timing, zero boundaries, shared gates and cache migration';
}
