import {summariseInventory} from './inventory.js';
const $=id=>document.getElementById(id);
const names={drums:'Drums',loops:'Loops',synth:'Synth',vocal:'Voice',fx:'FX',hat:'Hi-hat','drum-loop':'Drum loops','melodic-loop':'Melodic loops','vocal-loop':'Vocal loops','vocal-note':'Short vocals',unclassified:'Unassigned'};
const label=tag=>names[tag] || tag.charAt(0).toUpperCase()+tag.slice(1);
export function renderDashboard(state, actions, collection, currentName) {
    const current=summariseInventory([state.session.inventory || {}],state.session.taxonomy);
    const linked=Boolean(collection.root), combined=linked ? collection.summary() : current;
    $('library-dashboard').hidden=false;
    $('current-pack-name').textContent=currentName || 'Current folder';
    $('current-pack-counts').textContent=`${current.ready} ready · ${current.pending} to review · ${current.excluded} excluded`;
    $('collection-name').textContent=linked ? collection.root.name : 'Parent collection not linked';
    $('collection-context').textContent=linked ? collection.currentPath===null ? 'The current folder is outside this parent collection.' : `Current folder: ${collection.currentPath || '(parent itself)'}` : 'Choose the shared parent once to include sibling folders in your totals.';
    $('inventory-title').textContent=linked ? 'Ready across the collection' : 'Ready in this folder';
    $('inventory-total').textContent=`${combined.ready} unique sounds ready · ${combined.pending} awaiting review`;
    $('inventory-note').textContent=`${combined.samples} standalone samples · ${combined.hits} kit hits. Identical audio counts once; sounds can appear in several categories. Counts use saved catalogues${linked ? ' · updated '+new Date(collection.updatedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : ''}.`;
    const grid=$('inventory-groups');grid.replaceChildren();
    for(const [family,roles] of [...Object.entries(state.session.taxonomy),['unclassified',[]]]) {
        const section=document.createElement('section'),heading=document.createElement('h3'),list=document.createElement('div');
        heading.textContent=`${label(family)} · ${combined.categories[family].ready} ready`;list.className='inventory-categories';
        const tags=roles.length ? roles : [family];
        for(const tag of [...tags].sort((a,b)=>combined.categories[a].ready-combined.categories[b].ready || a.localeCompare(b))) {
            const count=combined.categories[tag],local=current.categories[tag];
            const button=document.createElement('button'),name=document.createElement('strong'),value=document.createElement('span'),detail=document.createElement('small');
            button.type='button';button.dataset.inventoryCategory=tag;button.className='inventory-category'+(!count.ready ? ' empty' : '');
            name.textContent=label(tag);value.textContent=`${count.ready} ready`;
            detail.textContent=linked ? `${local.ready} here · ${count.pending} to review across collection` : `${count.pending} to review`;
            button.append(name,value,detail);button.addEventListener('click',()=>{actions.focusCategory(tag);$('inventory-panel').open=false;$('review-app').scrollIntoView({block:'start'});});list.append(button);
        }
        section.append(heading,list);grid.append(section);
    }
    $('collection-folders').hidden=!linked;
    $('collection-focus').textContent=collection.goal ? `Focus: ${label(collection.goal)}. Folder counts below show this category.` : 'Folder counts below cover all categories.';
    $('collection-clear-focus').hidden=!collection.goal;
    $('collection-clear-focus').onclick=()=>actions.focusCategory('');
    const body=$('collection-folders-body');body.replaceChildren();
    for(const row of collection.catalogues) {
        const tr=document.createElement('tr'),name=document.createElement('th'),ready=document.createElement('td'),pending=document.createElement('td'),action=document.createElement('td'),button=document.createElement('button');
        name.scope='row';name.textContent=row.path || '(parent folder)';
        if(row.path===collection.currentPath) { name.textContent+=' · current';tr.className='current-pack'; }
        const summary=row.inventory ? summariseInventory([row.inventory],state.session.taxonomy) : null;
        const scope=summary && collection.goal ? summary.categories[collection.goal] : summary;
        ready.textContent=scope ? scope.ready : 'Unavailable';pending.textContent=scope ? scope.pending : row.error;
        button.textContent=row.path===collection.currentPath ? 'Reviewing' : 'Open';button.disabled=Boolean(row.error) || row.path===collection.currentPath;
        button.addEventListener('click',()=>actions.openPack(row.path));action.append(button);tr.append(name,ready,pending,action);body.append(tr);
    }
    for(const row of collection.unprepared) {
        const tr=document.createElement('tr'),name=document.createElement('th'),status=document.createElement('td');name.scope='row';name.textContent=row.path || '(parent folder)';status.colSpan=3;status.textContent='Not prepared · open this folder in sample processing';tr.append(name,status);body.append(tr);
    }
    $('collection-errors').textContent=collection.catalogues.some(row=>row.error) ? 'Some folders could not be read. Their sounds are excluded from these totals.' : '';
    $('decision-progress').textContent=linked ? `${current.ready} ready in this folder · ${combined.ready} ready across ${collection.root.name}` : `${current.ready} sounds ready in this folder`;
}
