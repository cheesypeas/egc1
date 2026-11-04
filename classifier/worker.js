import {Pipeline} from './pipeline.js';

const emit = event => postMessage(event);
const pendingDecodes = new Map();
let sequence = 0, pipeline = null;
const decode = (file, rate) => new Promise((resolve, reject) => {
    const token = ++sequence;
    pendingDecodes.set(token, {resolve, reject});
    emit({type: 'decode', token, file, rate});
});

self.onmessage = async ({data}) => {
    if (data.type === 'decoded') {
        const pending = pendingDecodes.get(data.token);
        if (pending) {
            pendingDecodes.delete(data.token);
            if (data.error) { pending.reject(new Error(data.error)); }
            else { pending.resolve(data.channels); }
        }
        return;
    }
    if (data.type === 'pause') { if (pipeline) { pipeline.pause = true; } return; }
    try {
        if (data.type === 'run') {
            if (pipeline?.running) { throw new Error('This folder is already being processed.'); }
            if (!pipeline) { pipeline = new Pipeline(emit, decode, {localModels: data.localModels}); }
            // Reset before acquiring the lock so an immediate pause is retained.
            pipeline.pause = false;
            await navigator.locks.request('egc-classifier-write', {ifAvailable: true}, async lock => {
                if (!lock) { throw new Error('The classifier is running in another tab. Pause that run before starting this one.'); }
                await pipeline.run(data);
            });
        } else if (data.type === 'correct') {
            await navigator.locks.request('egc-classifier-write', {ifAvailable: true}, async lock => {
                if (!lock) { throw new Error('Another tab is processing samples. Pause it before saving a correction.'); }
                await pipeline.correct(data.id, data.tags);
            });
        }
    } catch (error) {
        emit({type: 'error', message: error instanceof Error ? error.message : String(error)});
    }
};
