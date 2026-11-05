import {Folder, metadataZip} from '../storage.js';
import {ReviewLibrary} from './library.js';

const $ = id => document.getElementById(id);
let library = null, folder = null, name = '', writable = false, opening = false;
const cache = {
    async database() {
        if (!this.promise) {
            this.promise = new Promise((resolve,reject) => {
                const request = indexedDB.open('egc1-sample-tools',1);
                request.onupgradeneeded = () => request.result.createObjectStore('records');
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        }
        return this.promise;
    },
    memory: new Map(),
    async storedGet(key) { const db = await this.database(); return new Promise((resolve,reject) => { const request = db.transaction('records').objectStore('records').get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); },
    async storedSet(key,value) { const db = await this.database(); return new Promise((resolve,reject) => { const transaction = db.transaction('records','readwrite'); transaction.objectStore('records').put(value,key); transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); }); },
    async get(key) { try { return await this.storedGet(key); } catch (_) { return this.memory.get(key); } },
    async set(key,value) { this.memory.set(key,structuredClone(value)); try { await this.storedSet(key,value); } catch (_) { message('Browser storage is unavailable. Save metadata before closing.'); } },
};
window.egcReview = {
    request: (...args) => library.request(...args),
    audio: path => library.audio(path),
};
const message = text => { $('review-save-mode').textContent = text; };
function saveMode() {
    message(writable ? `${name} · Reviews save to .egc1 in this folder.` : `${name} · Reviews are saved in this browser. Download metadata to carry them with your samples; browser storage can be cleared.`);
    $('review-download').hidden = writable; $('review-import-button').hidden = false;
}
const script = document.createElement('script'); script.src = './app.js';
await new Promise((resolve,reject) => { script.onload = resolve; script.onerror = reject; document.head.append(script); });
async function open({handle = null, files: inputs = [], outputs = [], name: label = 'samples'}) {
    if (opening) { return; }
    opening = true; $('review-choose').disabled = true;
    try {
        message('Opening prepared library…');
        if (handle && await handle.queryPermission({mode:'readwrite'}) !== 'granted') { throw new Error('Choose the folder again to grant permission.'); }
        const candidateFolder = new Folder(handle,inputs, event => { if (event.message || event.stage) { message(event.message || event.stage); } });
        candidateFolder.outputs = new Map(outputs);
        const candidate = await new ReviewLibrary(candidateFolder,cache,message).initialise();
        folder = candidateFolder; library = candidate; name = label; writable = Boolean(handle);
        if (handle) { await cache.set('last-folder',{handle,name}); }
        $('refresh').disabled = false; $('export').disabled = false;
        document.body.classList.add('library-open');
        $('review-app').hidden = false; $('review-folder').querySelector('h1').textContent = 'Sample review';
        $('review-choose').textContent = 'change folder'; saveMode();
        await window.start();
    } catch (error) { message(error.message); }
    finally { opening = false; $('review-choose').disabled = false; }
}
$('review-choose').addEventListener('click',async () => {
    if (window.showDirectoryPicker && window.isSecureContext) {
        try { const handle = await window.showDirectoryPicker({id:'egc-samples',mode:'readwrite'}); await open({handle,name:handle.name}); }
        catch (error) { if (error.name !== 'AbortError') { message(error.message); } }
    } else { $('review-folder-input').click(); }
});
$('review-folder-input').addEventListener('change',async event => {
    const chosen = [...event.target.files]; if (!chosen.length) { return; }
    await open({name:chosen[0].webkitRelativePath.split('/')[0],files:chosen.map(file => ({path:file.webkitRelativePath.split('/').slice(1).join('/') || file.name,file}))});
});
$('review-download').addEventListener('click',async () => {
    const button = $('review-download'); button.disabled = true;
    try {
        const blob = await metadataZip(folder.outputs, fraction => message(`Preparing metadata ZIP · ${Math.floor(fraction*100)}%`));
        const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'egc1-metadata.zip'; link.click();
        setTimeout(() => URL.revokeObjectURL(url),10000); saveMode();
    } catch (error) { message(error.message); }
    finally { button.disabled = false; }
});
$('review-import-button').addEventListener('click',() => $('review-import').click());
$('review-import').addEventListener('change',async event => {
    try {
        const file = event.target.files[0]; if (!file) { return; }
        if (file.size > 64*1024*1024) { throw new Error('Review export is too large.'); }
        const count = await library.importReviews(JSON.parse(await file.text()));
        await window.start(); message(`Imported ${count} matching reviews. Newer saved judgements are retained.`);
    } catch (error) { message(error.message); }
    finally { event.target.value = ''; }
});
window.addEventListener('message',event => {
    if (event.origin !== location.origin || event.source !== window.opener || event.data?.type !== 'egc1-review-library') { return; }
    void open(event.data);
});
if (window.opener) { window.opener.postMessage({type:'egc1-review-ready'},location.origin); }
else {
    try {
        const saved = await cache.get('last-folder');
        if (saved?.handle && await saved.handle.queryPermission({mode:'readwrite'}) === 'granted') { await open(saved); }
    } catch (error) { message('Choose your prepared folder. Browser storage is unavailable; download metadata before closing.'); }
}
