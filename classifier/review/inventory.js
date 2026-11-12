import {hashFile} from '../audio.js';

async function legacyJson(folder,path) {
    let file;
    try { file=folder.handle ? await (await folder.entry(path)).getFile() : folder.files.get(path); }
    catch(error) { if(error.name==='NotFoundError'){return null;}throw error; }
    if(!file) { return null; }
    if(file.size>64*1024*1024) { throw Error('Metadata is too large'); }
    return JSON.parse(await file.text());
}

// Catalogue counts describe published audio; saved review labels alone are not ready sounds.
export function summariseInventory(catalogues, taxonomy) {
    const tags = [...Object.keys(taxonomy), ...Object.values(taxonomy).flat(), 'unclassified'];
    const groups = Object.fromEntries(tags.map(tag => [tag,{ready:new Set(),pending:new Set(),excluded:new Set()}]));
    const ready = new Set(), pending = new Set(), excluded = new Set(), samples = new Set(), hits = new Set();
    for (const [index,catalogue] of catalogues.entries()) {
        for (const state of ['ready','pending','excluded']) {
            for (const row of catalogue[state] || []) {
                const key = state === 'ready' ? row.id : `${index}:${row.id}`;
                (state === 'ready' ? ready : state === 'pending' ? pending : excluded).add(key);
                if (state === 'ready') { (row.kind === 'hit' ? hits : samples).add(row.id); }
                for (const tag of new Set(row.tags?.length ? row.tags : ['unclassified'])) { groups[tag]?.[state].add(key); }
            }
        }
    }
    return {ready:ready.size,pending:pending.size,excluded:excluded.size,samples:samples.size,hits:hits.size,
        categories:Object.fromEntries(Object.entries(groups).map(([tag,states]) => [tag,Object.fromEntries(Object.entries(states).map(([state,ids]) => [state,ids.size]))]))};
}

export async function readCatalogue(folder) {
    const current=await folder.json('.egc1/library.json');
    const manifest = current || await legacyJson(folder,'.toysampler/library.json');
    if (!manifest) { return null; }
    if (manifest.version !== 1 || !Array.isArray(manifest.entries)) { throw new Error('Unsupported prepared catalogue'); }
    const workspace = await folder.json('.egc1/workspace.json') || manifest;
    if (workspace.version !== 1 || !Array.isArray(workspace.entries)) { throw new Error('Unsupported review workspace'); }
    const ready=[],published=[];
    let unavailable=0;
    const audioFile=async path=>{
        try {
            if(!current && path.startsWith('.toysampler/')) { return folder.handle ? await (await folder.entry(path)).getFile() : folder.files.get(path); }
            return await folder.file(path);
        } catch(error) { if(error.name==='NotFoundError'){return null;}throw error; }
    };
    for(const row of manifest.entries.filter(row=>row.state==='ready')) {
        if(!/^[0-9a-f]{64}$/.test(row.id || '') || typeof row.path!=='string' || !await audioFile(row.path)) { unavailable++;continue; }
        published.push(row);ready.push({id:row.id,tags:row.tags || [],kind:'sample'});
    }
    for (const row of published) {
        const kit = current ? await folder.json(`.egc1/kits/${row.id}/kit.json`) : await legacyJson(folder,`.toysampler/kits/${row.id}/kit.json`);
        if (kit?.version === 1 && kit.sourceId === row.id && Array.isArray(kit.hits)) {
            for (const hit of kit.hits) {
                if(typeof hit.file!=='string' || hit.file.includes('/') || hit.file.includes('\\')) { unavailable++;continue; }
                const file=await audioFile(`${current ? '.egc1' : '.toysampler'}/kits/${row.id}/${hit.file}`);
                if(!file) { unavailable++;continue; }
                let id = hit.id;
                if (!/^[0-9a-f]{64}$/.test(id || '')) {
                    id=await hashFile(file);
                }
                const semantic=hit.browserTags ? null : current ? await folder.json(`.egc1/semantic/${id}.json`) : await legacyJson(folder,`.toysampler/semantic/${id}.json`);
                ready.push({id,tags:hit.browserTags || (semantic?.id===id && Array.isArray(semantic.tags) ? semantic.tags : ['drums']),kind:'hit'});
            }
        }
    }
    const candidates = state => workspace.entries.filter(row => row.state === state).map(row => ({id:row.reviewId || row.id,tags:row.tags || [],kind:row.browserKind === 'hit' ? 'hit' : 'sample'}));
    return {ready,pending:candidates('needs-review'),excluded:[...candidates('rejected'),...workspace.entries.filter(row=>row.duplicateOf && row.state==='ready').map(row=>({id:row.reviewId || row.id,tags:row.tags || [],kind:'sample'}))],unavailable,processing:manifest.state === 'processing'};
}
