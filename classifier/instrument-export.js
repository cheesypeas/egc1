import {Folder, safeRelative, canonicalPath, validAnalysis, validBanks} from './storage.js';
import {hashBytes, hashFile} from './audio.js';
import {BANKS} from './taxonomy.js';

const HASH = /^[0-9a-f]{64}$/;
const RECEIPT = '.egc1/instrument-export.json';
const jsonBlob = value => new Blob([JSON.stringify(value, null, 2) + '\n'], {type:'application/json'});
const joined = (root, path) => root ? `${root}/${path}` : path;
const check = (condition, message) => { if (!condition) { throw Error(message); } };
const cancelled = signal => { if (signal?.aborted) { throw new DOMException('Export stopped. Run export again to resume.', 'AbortError'); } };

async function optionalFile(folder, path) {
    try { return await folder.file(path); }
    catch (error) { if (error.name === 'NotFoundError') { return null; } throw error; }
}

// Read legacy packs without migrating or otherwise writing to the source.
async function sourceFile(folder, path) {
    const current = await optionalFile(folder, path);
    if (current || !path.startsWith('.egc1/')) { return current; }
    const legacy = '.toysampler/' + path.slice('.egc1/'.length);
    if (!folder.handle) { return folder.files.get(legacy) || null; }
    try { return await (await folder.entry(legacy)).getFile(); }
    catch (error) { if (error.name === 'NotFoundError') { return null; } throw error; }
}

async function sourceJson(folder, path) {
    const file = await sourceFile(folder, path);
    if (!file) { return null; }
    check(file.size <= 64 * 1024 * 1024, `Metadata is too large: ${path}`);
    try { return JSON.parse(await file.text()); }
    catch (_) { throw Error(`Cannot read ${path}. Repair this folder before exporting.`); }
}

export function instrumentExportName(name) {
    const clean = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100);
    return `EGC1 - ${clean || 'samples'}`;
}

export async function planInstrumentExport(sources, progress = () => {}, signal) {
    const files = new Map(), publications = new Map(), seeds = new Map(), names = new Map(), catalogues = [];
    const sampleIds = new Set(), hitIds = new Set();
    let samples = 0, hits = 0;
    const add = async (path, file, expectedHash = null) => {
        safeRelative(path);
        const key = path.normalize('NFC').toLowerCase();
        check(!names.has(key) || names.get(key) === path, `Paths collide on a USB stick: ${names.get(key)} and ${path}`);
        names.set(key, path);
        const previous = files.get(path);
        if (previous) {
            check(previous.file.size === file.size && (!previous.expectedHash || !expectedHash || previous.expectedHash === expectedHash), `Conflicting export files: ${path}`);
            if (!expectedHash || previous.expectedHash !== expectedHash) {
                check(await sameBytes(previous.file, file, signal), `Conflicting export files: ${path}`);
            }
            previous.expectedHash ||= expectedHash;
        } else { files.set(path, {file, expectedHash}); }
    };
    for (const {folder, path = ''} of sources) {
        cancelled(signal);
        if (path) { safeRelative(path); }
        check(!catalogues.includes(path), 'Duplicate collection folder');
        const manifest = await sourceJson(folder, '.egc1/library.json');
        check(manifest?.version === 1 && Array.isArray(manifest.entries), `No prepared catalogue in ${path || 'the selected folder'}`);
        catalogues.push(path);
        const entries = manifest.entries.filter(row => row.state === 'ready' && !row.duplicateOf);
        for (const row of entries) {
            cancelled(signal);
            progress({stage:'planning', path:joined(path, row.path), samples, hits});
            check(HASH.test(row.id || ''), `Invalid sample identity: ${row.path}`);
            const relative = canonicalPath(safeRelative(row.path));
            const file = await sourceFile(folder, relative);
            check(file && file.size === row.bytes, `Missing or changed playable audio: ${joined(path, relative)}`);
            const analysisPath = `.egc1/entries/${row.id}.json`, data = await sourceJson(folder, analysisPath);
            check(typeof data?.pipeline === 'string' && validAnalysis(data, row.id, data.pipeline, {channels:row.channels, frames:row.samples, rate:row.rate}), `Missing or invalid analysis: ${joined(path, relative)}`);
            await add(joined(path, relative), file, row.id);
            await add(joined(path, analysisPath), await sourceFile(folder, analysisPath));
            const provenance = row.provenance;
            if (provenance) {
                check(provenance.kind === 'separated' && HASH.test(provenance.sourceId || '') && Number.isInteger(provenance.start) && Number.isInteger(provenance.end) && provenance.start >= 0 && provenance.end <= provenance.sourceSamples && provenance.end - provenance.start === row.samples && provenance.rate === row.rate && relative.startsWith(`.egc1/regions/${provenance.sourceId}/`), `Invalid source provenance: ${relative}`);
                const parentPath = safeRelative(provenance.sourcePath);
                check(!parentPath.split('/').some(part => part === '.egc1' || part === '.toysampler'), `Invalid original source path: ${parentPath}`);
                const parent = await sourceFile(folder, parentPath);
                check(parent, `Missing original audio needed for verification: ${joined(path, parentPath)}`);
                await add(joined(path, parentPath), parent, provenance.sourceId);
            } else { check(!relative.startsWith('.egc1/'), `Generated audio needs source provenance: ${relative}`); }
            sampleIds.add(row.id); samples = sampleIds.size;
            const kitPath = `.egc1/kits/${row.id}/kit.json`, kit = await sourceJson(folder, kitPath);
            if (kit) {
                check(kit.version === 1 && kit.sourceId === row.id && kit.rate === row.rate && Array.isArray(kit.hits) && kit.hits.length <= 8, `Invalid kit: ${kitPath}`);
                for (const hit of kit.hits) {
                    check(typeof hit.file === 'string' && !hit.file.includes('/') && !hit.file.includes('\\') && Number.isInteger(hit.start) && Number.isInteger(hit.end) && hit.start >= 0 && hit.end > hit.start && hit.end <= row.samples, `Invalid kit hit: ${kitPath}`);
                    const hitPath = `.egc1/kits/${row.id}/${safeRelative(hit.file)}`, audio = await sourceFile(folder, hitPath);
                    check(audio, `Missing kit audio: ${joined(path, hitPath)}`);
                    const id = HASH.test(hit.id || '') ? hit.id : await digest(audio, signal);
                    await add(joined(path, hitPath), audio, id);
                    hitIds.add(id); hits = hitIds.size;
                }
                publications.set(joined(path, kitPath), kit);
            }
        }
        const banks = await sourceJson(folder, '.egc1/banks.json');
        await add(joined(path, '.egc1/banks.json'), jsonBlob(validBanks(banks || BANKS)));
        // Initial favourites/flags travel with the library. Later exports must
        // preserve feedback recorded on the instrument, including live takes.
        for (const name of ['instrument-feedback.json', 'instrument-resolutions.json']) {
            const file = await sourceFile(folder, `.egc1/${name}`);
            if (file) { seeds.set(joined(path, `.egc1/${name}`), file); }
        }
        publications.set(joined(path, '.egc1/library.json'), {...manifest, state:manifest.state === 'processing' ? 'complete' : manifest.state, entries:entries.map(row => ({...row, path:canonicalPath(row.path), provenance:row.provenance ? {...row.provenance, sourcePath:canonicalPath(row.provenance.sourcePath)} : undefined}))});
    }
    check(catalogues.length, 'No prepared folders to export');
    // Check metadata/audio conflicts too, including overlaps between a parent
    // catalogue and a separately prepared child folder.
    for (const [path, value] of publications) { await add(path, jsonBlob(value)); }
    for (const [path, file] of seeds) { await add(path, file); }
    return {sources, files, publications, seeds, catalogues, samples, hits, bytes:[...files.values()].reduce((sum, item) => sum + item.file.size, 0)};
}

async function sameBytes(a, b, signal) {
    if (a.size !== b.size) { return false; }
    for (let at = 0; at < a.size; at += 4 * 1024 * 1024) {
        cancelled(signal);
        const [left, right] = await Promise.all([a.slice(at, at + 4 * 1024 * 1024).arrayBuffer(), b.slice(at, at + 4 * 1024 * 1024).arrayBuffer()]);
        const x = new Uint8Array(left), y = new Uint8Array(right);
        for (let i = 0; i < x.length; i++) { if (x[i] !== y[i]) { return false; } }
    }
    return true;
}

async function digest(file, signal) {
    cancelled(signal);
    if (file.size <= 64 * 1024 * 1024) { return hashBytes(await file.arrayBuffer()); }
    return hashFile(file, () => cancelled(signal));
}

async function writeFile(folder, path, blob, signal) {
    const file = await folder.entry(path, true), stream = await file.createWritable();
    try {
        for (let at = 0; at < blob.size; at += 4 * 1024 * 1024) {
            cancelled(signal);
            await stream.write(blob.slice(at, at + 4 * 1024 * 1024));
        }
        cancelled(signal);
        await stream.close();
    } catch (error) { try { await stream.abort(); } catch (_) {} throw error; }
}

export async function exportInstrumentLibrary(plan, parent, name, {progress = () => {}, signal, sourceRoots = []} = {}) {
    cancelled(signal);
    const outputName = instrumentExportName(name);
    // Reject source/destination overlap before creating or writing anything.
    const roots = [...sourceRoots, ...plan.sources.map(source => source.folder.handle)].filter(Boolean);
    for (const root of roots) {
        check(await root.resolve(parent) === null, 'Choose a destination outside your source collection');
        const ancestor = await parent.resolve(root);
        check(!ancestor || ancestor[0]?.normalize('NFC').toLowerCase() !== outputName.normalize('NFC').toLowerCase(), 'The export would overlap your source collection');
    }
    const output = await parent.getDirectoryHandle(outputName, {create:true}), destination = new Folder(output);
    const receipt = await destination.json(RECEIPT);
    if (receipt) {
        check(receipt.version === 1 && receipt.type === 'egc1-instrument-export' && receipt.source === name && Array.isArray(receipt.catalogues) && receipt.catalogues.every(path => typeof path === 'string' && (!path || safeRelative(path))), 'This destination belongs to another export');
    } else {
        for await (const _ of output.entries()) { throw Error(`${outputName} already contains files from another source. Choose another destination parent.`); }
    }
    const stats = {copied:0, skipped:0, bytesWritten:0, files:plan.files.size, name:outputName}, changed = new Set();
    const update = async (path, blob, {seed = false, counted = true, expectedHash = null} = {}) => {
        cancelled(signal);
        progress({...stats, stage:'copying', path});
        const old = await optionalFile(destination, path);
        if (seed && old) { if (counted) { stats.skipped++; } return; }
        if (expectedHash) { check(await digest(blob, signal) === expectedHash, `Source audio changed: ${path}. Prepare this folder again before exporting.`); }
        if (old && await sameBytes(old, blob, signal)) {
            if (counted) { if (changed.has(path)) { stats.copied++; } else { stats.skipped++; } }
            return;
        }
        await writeFile(destination, path, blob, signal);
        if (path !== RECEIPT) { changed.add(path); stats.bytesWritten += blob.size; }
        if (counted) { stats.copied++; }
    };
    const pending = {version:1, type:'egc1-instrument-export', source:name, catalogues:[...new Set([...(receipt?.catalogues || []), ...plan.catalogues])].sort()};
    await update(RECEIPT, jsonBlob(pending), {counted:false});
    // Withdraw removed choices first, including kits whose parent stays ready.
    // No file is deleted; old audio and instrument-created files are retained.
    for (const root of pending.catalogues) {
        const path = joined(root, '.egc1/library.json'), old = await destination.json(path), next = plan.publications.get(path);
        if (!old) { continue; }
        check(Array.isArray(old.entries), `Invalid destination catalogue: ${path}`);
        const allowed = new Set((next?.entries || []).map(row => `${row.id}:${row.path}`));
        const retained = old.entries.filter(row => allowed.has(`${row.id}:${row.path}`));
        if (retained.length !== old.entries.length) { await update(path, jsonBlob({...old, entries:retained}), {counted:false}); }
        for (const row of retained) {
            const kitPath = joined(root, `.egc1/kits/${row.id}/kit.json`), kit = await destination.json(kitPath);
            if (!kit) { continue; }
            check(Array.isArray(kit.hits), `Invalid destination kit: ${kitPath}`);
            const keep = new Set((plan.publications.get(kitPath)?.hits || []).map(hit => `${hit.file}:${hit.id || ''}:${hit.start}:${hit.end}`));
            const kept = kit.hits.filter(hit => keep.has(`${hit.file}:${hit.id || ''}:${hit.start}:${hit.end}`));
            if (kept.length !== kit.hits.length) { await update(kitPath, jsonBlob({...kit, hits:kept}), {counted:false}); }
        }
    }
    for (const [path, {file, expectedHash}] of plan.files) {
        if (plan.publications.has(path)) { continue; }
        await update(path, file, {expectedHash, seed:plan.seeds.has(path)});
    }
    // Publish kits before catalogues, after every referenced file is complete.
    for (const suffix of ['/kit.json', '/library.json']) {
        for (const [path, value] of plan.publications) {
            if (path.endsWith(suffix)) { await update(path, jsonBlob(value)); }
        }
    }
    await update(RECEIPT, jsonBlob({...pending, catalogues:plan.catalogues.slice().sort()}), {counted:false});
    for (const path of changed) { if (!plan.files.has(path)) { stats.copied++; stats.files++; } }
    progress({...stats, stage:'complete', path:''});
    return stats;
}

// Shared browser controls; callers supply the current folder or linked packs.
export function mountInstrumentExport(element, sources, busy = () => {}, sourceRoots = () => []) {
    const button = element.querySelector('[data-export-start]'), stop = element.querySelector('[data-export-stop]'), status = element.querySelector('[data-export-status]');
    let controller = null;
    const progress = data => {
        status.textContent = data.stage === 'planning' ? `Checking published sounds · ${data.samples} samples · ${data.path}` : `${data.copied + data.skipped} / ${data.files} files · ${data.copied} copied · ${data.skipped} unchanged · ${(data.bytesWritten / 1048576).toFixed(1)} MiB written${data.path ? ' · ' + data.path : ''}`;
    };
    if (!window.showDirectoryPicker) { button.disabled = true; status.textContent = 'Open this page in desktop Chrome or Edge to export directly to a USB stick or folder.'; }
    stop.addEventListener('click', () => { controller?.abort(); });
    window.addEventListener('beforeunload', event => { if (controller) { event.preventDefault(); event.returnValue = ''; } });
    button.addEventListener('click', async () => {
        if (controller) { return; }
        try {
            const parent = await window.showDirectoryPicker({id:'egc-instrument-destination', mode:'readwrite'});
            controller = new AbortController(); button.disabled = true; stop.hidden = false; busy(true);
            const run = async () => {
                const selection = await sources();
                const plan = await planInstrumentExport(selection.sources, progress, controller.signal);
                status.textContent = `${plan.samples} published samples + ${plan.hits} kit hits · ${plan.files.size} files · ${(plan.bytes / 1048576).toFixed(1)} MiB. Preparing destination…`;
                const result = await exportInstrumentLibrary(plan, parent, selection.name, {progress, signal:controller.signal, sourceRoots:sourceRoots()});
                status.textContent = `Export complete: ${result.name} · ${plan.samples} published samples + ${plan.hits} kit hits · ${result.copied} files copied · ${result.skipped} unchanged · ${(result.bytesWritten / 1048576).toFixed(1)} MiB written. Eject the USB stick safely before removing it.`;
            };
            await navigator.locks.request('egc-classifier-write', {ifAvailable:true}, lock => {
                if (!lock) { throw Error('Finish or pause sample processing in other tabs before exporting'); }
                return run();
            });
        } catch (error) { if (controller || error.name !== 'AbortError') { status.textContent = error.message; } }
        finally { controller = null; button.disabled = !window.showDirectoryPicker; stop.hidden = true; busy(false); }
    });
}
