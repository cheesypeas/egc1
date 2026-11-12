import {Folder, metadataZip} from '../storage.js';
import {ReviewLibrary,CATEGORIES} from './library.js';
import {readCatalogue} from './inventory.js';
import {Collection} from './collection.js';
import {renderDashboard} from './dashboard.js';
import {renderAdmission,curateCurrent} from './admission.js';
import {mountInstrumentExport} from '../instrument-export.js';

const $ = id => document.getElementById(id);
let library = null, folder = null, name = '', writable = false, opening = false, sourceSession = null, collectionPath = null, viewState = null, viewActions = null;
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
    renderAdmission,curateCurrent,
    renderLibrary: (state,actions) => {
        viewState=state;viewActions=actions;
        renderDashboard(state,dashboardActions(),collection,name);
    },
    request: async (...args) => {
        const before = new Map(folder.outputs), result = await library.request(...args);
        if (args[0].startsWith('/api/session')) { result.inventory=await readCatalogue(folder);result.folderKey=collection.currentPath!==null ? collection.root.name+'/'+collection.currentPath : '/'+name; }
        if (args[1] !== undefined && collection.root) {
            if(collection.similarityEnabled && /^\/api\/(admit|withhold|undo)/.test(args[0])) { await collection.consolidate(current()); }
            try { await collection.updateCurrent(current()); }
            catch(error) { message('Sound decision saved; collection totals could not be saved: '+error.message); }
        }
        if (args[1] !== undefined && window.opener && sourceSession) {
            window.opener.postMessage({type:'egc1-publication-changed',session:sourceSession,
                outputs:[...folder.outputs].filter(([path,blob]) => before.get(path) !== blob)},location.origin);
        }
        return result;
    },
    audio: path => library.audio(path),
};
const message = text => { $('review-save-mode').textContent = text; };
const current = () => folder ? {folder,handle:folder.handle,files:[...folder.files].map(([path,file])=>({path,file})),outputs:[...folder.outputs],name,session:sourceSession,collectionPath} : null;
const collection = new Collection(cache,CATEGORIES,()=>{
    if(viewState){
        if(!opening && collection.currentPath!==null) {
            const key=collection.root.name+'/'+collection.currentPath;
            if(viewState.session.folderKey!==key){window.rememberDraft();viewState.session.folderKey=key;window.rememberDraft();}
        }
        renderDashboard(viewState,dashboardActions(),collection,name);
    }
},message);
mountInstrumentExport($('instrument-export'), async () => {
    if (viewState?.saving || opening) { throw Error('Wait for the current sound decision to finish'); }
    window.rememberDraft();
    if ($('instrument-export-scope').value !== 'collection') {
        if (!folder) { throw Error('Choose a prepared folder first'); }
        return {name, sources:[{folder}]};
    }
    if (!collection.root) { throw Error('Choose the shared parent folder first'); }
    const sources = [];
    for (const row of collection.catalogues) {
        if (row.error) { throw Error(`Cannot export ${row.path}: ${row.error}`); }
        const pack = await collection.open(row.path);
        const source = pack.folder || new Folder(pack.handle, pack.files || []);
        if (!pack.folder) { source.outputs = new Map(pack.outputs || []); }
        sources.push({path:row.path, folder:source});
    }
    return {name:collection.root.name, sources};
}, value => {
    $('review-app').inert = value;
    $('review-folder').inert = value;
    $('review-toolbar').inert = value;
    for (const element of $('library-dashboard').children) {
        if (element.id !== 'instrument-export') { element.inert = value; }
    }
    $('instrument-export-scope').disabled = value;
}, () => collection.root?.handle ? [collection.root.handle] : []);
function dashboardActions() {
    return {...viewActions,openPack,focusCategory:tag=>{collection.goal=tag;viewActions.focusCategory(tag);}};
}
async function openPack(path) {
    try {
        if(viewState?.saving) { throw Error('Wait for the current sound decision to finish'); }
        window.rememberDraft();
        if(folder && collection.currentPath!==null) { collection.packs.set(collection.currentPath,current()); }
        const pack=await collection.open(path);
        if(pack.handle && await pack.handle.queryPermission({mode:'readwrite'})!=='granted' && await pack.handle.requestPermission({mode:'readwrite'})!=='granted') { throw Error('Folder access was not granted'); }
        await open(pack);
        if(collection.goal) { viewActions.focusCategory(collection.goal); }
    } catch(error) { message(error.message); }
}
$('collection-choose').addEventListener('click',async()=>{
    try {
        if(window.showDirectoryPicker && window.isSecureContext) {
            const handle=await window.showDirectoryPicker({id:'egc-collection-parent',mode:'readwrite'});
            await collection.attach({handle,name:handle.name},current());saveMode();
        } else { $('collection-folder-input').click(); }
    } catch(error) { if(error.name!=='AbortError'){message(error.message);} }
});
$('collection-folder-input').addEventListener('change',async event=>{
    const chosen=[...event.target.files];if(!chosen.length){return;}
    try {
        const rootName=chosen[0].webkitRelativePath.split('/')[0];
        const files=chosen.map(file=>({path:file.webkitRelativePath.split('/').slice(1).join('/'),file}));
        await collection.attach({name:rootName,files},current());saveMode();
    } catch(error) { message(error.message); }
});
$('deduplicate-loops').addEventListener('click',async()=>{
    const button=$('deduplicate-loops');
    if(!library || viewState?.saving) { return; }
    button.disabled=true;
    $('review-app').inert=true;$('library-dashboard').inert=true;
    try {
        window.rememberDraft();
        const summary=collection.root ? await collection.consolidate(current()) : await library.request('/api/deduplicate',{});
        await library.initialise();
        await window.start();
        $('loop-similarity-status').textContent=`${summary.checked} loops compared · ${summary.retained} representatives kept · ${summary.excluded} very similar alternatives excluded. Originals are retained.${!writable ? ' Download updated metadata'+(collection.root ? ' and extract it into the parent folder.' : '.') : ''}`;
    } catch(error) { $('loop-similarity-status').textContent=error.message; }
    finally { button.disabled=false;$('review-app').inert=false;$('library-dashboard').inert=false; }
});
$('collection-refresh').addEventListener('click',async()=>{try{await collection.refresh(current());saveMode();}catch(error){message(error.message);}});
$('collection-download').addEventListener('click',()=>{
    const url=URL.createObjectURL(new Blob([JSON.stringify(collection.snapshot(),null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='egc1-collection.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
function saveMode() {
    message(writable ? `${name} · Reviews save to .egc1 in this folder.` : `${name} · Reviews are saved in this browser. Download metadata to carry them with your samples; browser storage can be cleared.`);
    $('review-download').hidden = writable; $('review-import-button').hidden = false;
}
const script = document.createElement('script'); script.src = './app.js';
await new Promise((resolve,reject) => { script.onload = resolve; script.onerror = reject; document.head.append(script); });
async function open({handle = null, files: inputs = [], outputs = [], name: label = 'samples', session = null, collectionPath: selectedPath = null}) {
    if (opening) { return; }
    opening = true; $('review-choose').disabled = true;
    try {
        message('Opening prepared library…');
        if (handle && await handle.queryPermission({mode:'readwrite'}) !== 'granted') { throw new Error('Choose the folder again to grant permission.'); }
        const candidateFolder = new Folder(handle,inputs, event => { if (event.message || event.stage) { message(event.message || event.stage); } });
        candidateFolder.outputs = new Map(outputs);
        const candidate = await new ReviewLibrary(candidateFolder,cache,message).initialise();
        window.resetReviewFolder();
        folder = candidateFolder; library = candidate; name = label; writable = Boolean(handle); sourceSession = session; collectionPath=selectedPath;
        if(collection.root) { collection.currentPath=await collection.locate(current()); }
        if (handle) { await cache.set('last-folder',{handle,name}); }
        $('refresh').disabled = false; $('export').disabled = false; $('deduplicate-loops').disabled=false;
        document.body.classList.add('library-open');
        $('review-app').hidden = false; $('review-folder').querySelector('h1').textContent = 'Sample review';
        $('review-choose').textContent = 'change folder'; saveMode();
        await window.start();
        if(collection.root) { await collection.updateCurrent(current()); }
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
        const collectionExport=collection.similarityEnabled && !collection.root?.handle;
        const blob = await metadataZip(collectionExport ? collection.metadataOutputs() : folder.outputs, fraction => message(`Preparing metadata ZIP · ${Math.floor(fraction*100)}%`));
        const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = collectionExport ? 'egc1-collection-metadata.zip' : 'egc1-metadata.zip'; link.click();
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

try {
    const parent=await cache.get('collection-parent');
    if(parent?.handle && await parent.handle.queryPermission({mode:'readwrite'})==='granted') { await collection.attach(parent,current()); }
} catch(error) { message('Choose the collection parent again to refresh sibling totals.'); }
