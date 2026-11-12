import {readWorkspace,publishWorkspace,selectLoopRepresentatives} from '../preparation.js';
import {Folder,AUDIO_EXTENSION} from '../storage.js';
import {readCatalogue,summariseInventory} from './inventory.js';

export class Collection {
    constructor(cache, taxonomy, changed, progress = () => {}) {
        this.cache=cache;this.taxonomy=taxonomy;this.changed=changed;this.progress=progress;
        this.root=null;this.catalogues=[];this.unprepared=[];this.currentPath=null;this.packs=new Map();
    }
    async attach(root, current) {
        this.packs.clear();
        this.root=root;
        const saved=await new Folder(root.handle,root.files || []).json('.egc1/collection.json') || await this.cache.get('collection-snapshot');
        this.similarityEnabled=Boolean(saved?.name===root.name && saved.loopSimilarityEnabled);
        await this.refresh(current);
        if (root.handle) { await this.cache.set('collection-parent',{handle:root.handle,name:root.name}); }
    }
    async refresh(current) {
        if (!this.root) { return; }
        const catalogues=[],unprepared=[], root=this.root;
        let visited=0;
        const visit = async (handle,path,covered=false) => {
            this.progress(`Reading collection folders · ${++visited}`);
            const folder=new Folder(handle);
            let catalogue;
            try { catalogue=await readCatalogue(folder); }
            catch(error) { catalogues.push({path,name:path || root.name,error:error.message}); }
            if (catalogue) { catalogues.push({path,name:path || root.name,inventory:catalogue,handle}); }
            let audio=false,children=[];
            for await (const [name,entry] of handle.entries()) {
                if (name.startsWith('.') || name==='__MACOSX') { continue; }
                if (entry.kind==='directory') { children.push([name,entry]); }
                else if(AUDIO_EXTENSION.test(name)) { audio=true; }
            }
            if (!catalogue && audio && !covered) { unprepared.push({path,name:path || root.name}); }
            for (const [name,child] of children) { await visit(child,path ? path+'/'+name : name,covered || Boolean(catalogue)); }
        };
        if (root.handle) { await visit(root.handle,''); }
        else {
            const roots=new Set(),audioRoots=new Set();
            for (const {path} of root.files) {
                const match=path.match(/^(?:(.*)\/)?(?:\.egc1|\.toysampler)\/library\.json$/);
                if(match) { roots.add(match[1] || ''); }
                if(AUDIO_EXTENSION.test(path) && !path.split('/').some(part=>part.startsWith('.'))) { audioRoots.add(path.split('/').slice(0,-1).join('/')); }
            }
            for (const path of roots) {
                const prefix=path ? path+'/' : '';
                const files=root.files.filter(row=>row.path.startsWith(prefix)).map(row=>({path:row.path.slice(prefix.length),file:row.file}));
                try { const inventory=await readCatalogue(new Folder(null,files));catalogues.push({path,name:path || root.name,inventory,files}); }
                catch(error) { catalogues.push({path,name:path || root.name,error:error.message}); }
            }
            for(const path of audioRoots) { if(![...roots].some(parent=>!parent || path===parent || path.startsWith(parent+'/'))) { unprepared.push({path,name:path || root.name}); } }
        }
        catalogues.sort((a,b)=>a.path.localeCompare(b.path,undefined,{numeric:true}));
        if(!root.handle) {
            for(const row of catalogues) {
                const saved=this.packs.get(row.path);
                if(saved?.folder) { row.inventory=await readCatalogue(saved.folder); }
            }
        }
        this.catalogues=catalogues;this.unprepared=unprepared;
        await this.updateCurrent(current);
    }
    async locate(current) {
        if(!this.root || !current) { return null; }
        if(this.root.handle && current.handle) { const path=await this.root.handle.resolve(current.handle);return path ? path.join('/') : null; }
        if(current.collectionPath!==null && current.collectionPath!==undefined && this.catalogues.some(row=>row.path===current.collectionPath)) { return current.collectionPath; }
        const candidates=this.catalogues.filter(row=>(row.path.split('/').pop() || this.root.name)===current.name);
        const matches=candidates.filter(row=>{
            const files=new Map((row.files || []).map(file=>[file.path,file.file]));
            const originals=[...current.folder.files].filter(([path])=>!path.split('/').some(part=>part.startsWith('.')));
            return originals.length>0 && originals.every(([path,file])=>files.get(path)?.size===file.size && files.get(path)?.lastModified===file.lastModified);
        });
        return matches.length===1 ? matches[0].path : null;
    }
    async updateCurrent(current) {
        this.currentPath=await this.locate(current);
        if(this.currentPath!==null && current?.folder) {
            const inventory=await readCatalogue(current.folder);
            if(inventory) {
                const row=this.catalogues.find(row=>row.path===this.currentPath);
                if(row) { row.inventory=inventory;delete row.error; }
                this.packs.set(this.currentPath,current);
            }
        }
        this.updatedAt=new Date().toISOString();
        const snapshot=this.snapshot();
        await this.cache.set('collection-snapshot',snapshot);
        if(this.root?.handle) {
            await new Folder(this.root.handle).writeJson('.egc1/collection.json',snapshot);
        }
        this.changed(snapshot);
    }
    snapshot() {
        return {version:1,type:'sample-collection',name:this.root?.name || '',updatedAt:this.updatedAt,
            currentPath:this.currentPath,loopSimilarityEnabled:Boolean(this.similarityEnabled),catalogues:this.catalogues.map(({path,name,inventory,error})=>({path,name,inventory,error})),unprepared:this.unprepared};
    }
    summary() { return summariseInventory(this.catalogues.filter(row=>row.inventory).map(row=>row.inventory),this.taxonomy); }
    async consolidate(current) {
        const execute=async()=>{
            if(current?.folder && this.currentPath!==null) { this.packs.set(this.currentPath,current); }
            const sources=[];
            for(const pack of this.catalogues) {
                if(pack.error) { throw Error('Resolve unreadable collection folders before comparing loops'); }
                const saved=this.packs.get(pack.path);
                const folder=saved?.folder || new Folder(pack.handle,pack.files || []);
                await folder.initialise({locked:true});
                const workspace=await readWorkspace(folder);
                if(!workspace?.entries) { continue; }
                sources.push({folder,workspace,pack:pack.path});
                this.packs.set(pack.path,{...pack,folder,outputs:[...folder.outputs],collectionPath:pack.path});
            }
            const summary=await selectLoopRepresentatives(sources,this.progress);
            // Withdraw every discarded choice before publishing any promoted
            // representative in a sibling pack. Interrupted saves can withhold
            // extra sounds, but cannot publish both versions during a swap.
            for(const source of sources) {
                const manifest=await source.folder.json('.egc1/library.json');
                const allowed=new Set(source.workspace.entries.filter(row=>row.state==='ready' && !row.duplicateOf).map(row=>(row.output || row).id));
                if(manifest?.entries.some(row=>!allowed.has(row.id))) {
                    await source.folder.writeJson('.egc1/library.json',{...manifest,entries:manifest.entries.filter(row=>allowed.has(row.id))});
                }
            }
            for(const source of sources) {
                const loops=source.workspace.entries.filter(row=>row.state==='ready' && row.tags?.includes('loops'));
                source.workspace.loopSimilarity={method:summary.method,scope:'collection',pack:source.pack,
                    checked:loops.length,retained:loops.filter(row=>!row.duplicateOf).length,excluded:loops.filter(row=>row.duplicateOf).length};
                await publishWorkspace(source.folder,source.workspace,{grouped:true});
            }
            this.similarityEnabled=true;
            await this.refresh(current);
            return summary;
        };
        return globalThis.navigator?.locks ? navigator.locks.request('egc-classifier-write',{ifAvailable:true},lock=>{
            if(!lock) { throw Error('Pause sample processing in other tabs before comparing loops'); }
            return execute();
        }) : execute();
    }
    metadataOutputs() {
        const outputs=new Map();
        for(const [path,pack] of this.packs) {
            for(const [file,blob] of pack.folder?.outputs || []) { outputs.set((path ? path+'/' : '')+file,blob); }
        }
        return outputs;
    }
    async open(path) {
        const row=this.catalogues.find(row=>row.path===path);
        if(!row || row.error) { throw Error('This folder has no readable prepared library'); }
        const previous=this.packs.get(path);
        if(previous) { return {...previous,collectionPath:path}; }
        return {handle:row.handle || null,files:row.files || [],name:row.name,collectionPath:path};
    }
}
