const $ = id => document.getElementById(id);
let context = null, selected = null, busy = false, playerUrl = null, observedBounds = '';
const correctionFields=['start','end','root','beats','transients'];
function draftKey(state) { return 'egc1-correction:'+state.session.fingerprint+':'+state.current.id; }
function rememberCorrections() {
    if(!context?.state.current){return;}
    try { localStorage.setItem(draftKey(context.state),JSON.stringify(Object.fromEntries(correctionFields.map(name=>[name,$('admission-'+name).value])))); }
    catch(_) { /* Folder decisions remain durable when optional browser drafts are unavailable. */ }
}
for(const name of correctionFields) { $('admission-'+name).addEventListener('input',rememberCorrections); }
for(const name of ['start','end']) {
    $('admission-'+name).addEventListener('change',()=>{
        if(!context?.state.current){return;}
        const rate=context.state.current.rate,start=Math.round(Number($('admission-start').value)*rate),end=Math.round(Number($('admission-end').value)*rate);
        if(Number.isInteger(start) && Number.isInteger(end) && start>=0 && end>start && end<=context.state.current.sourceFrames) { context.setBounds({attackFrame:start,endFrame:end}); }
    });
}

export function renderAdmission(state, refresh, setBounds, advance, persist, queue) {
    context = {state,refresh,setBounds,advance,persist,queue};
    const item = state.current;
    $('admission').hidden = !state.session.publicationSupported || !item;
    if ($('admission').hidden) { return; }
    $('admission-state').textContent = item.publication === 'ready' ? 'Included in the playable library' : item.duplicateOf ? 'Similar loop excluded · one representative kept' : 'Excluded from the playable library';
    $('admission-reasons').textContent = item.duplicateOf ? `Kept: ${item.duplicateOf.pack ? item.duplicateOf.pack+'/' : ''}${item.duplicateOf.path}. Approve this version to use it instead.` : item.publication==='ready' && item.admission ? 'Earlier checks resolved by your approval.' : (item.preparation?.reasons || []).map(reason => reason.replaceAll('-', ' ')).join(' · ');
    $('admission-beats-label').hidden = !state.draft.tags.includes('loops');
    const loop=state.draft.tags.includes('loops'), synth=state.draft.tags.includes('synth');
    $('admission-end').parentElement.firstChild.textContent=loop ? 'Loop end (source seconds)' : 'End (optional tail trim, source seconds)';
    $('admission-root').parentElement.hidden=!synth && !state.draft.reasons.includes('wrong-root');
    $('admission-audition').disabled = item.publication !== 'ready';
    const boundsSignature=`${item.id}:${state.draft.boundaries.attackFrame}:${state.draft.boundaries.endFrame}`;
    const selectionId=state.session.folderKey+':'+state.session.fingerprint+':'+item.id;
    if (selected !== selectionId) {
        selected = selectionId;
        $('admission-player').pause(); $('admission-player').hidden = true;
        if (playerUrl) { URL.revokeObjectURL(playerUrl); playerUrl = null; }
        const bounds = item.preparation?.bounds;
        $('admission-start').value = ((state.draft.boundaries.attackFrame ?? (bounds ? item.startFrame + bounds.start : item.startFrame)) / item.rate).toFixed(6);
        $('admission-end').value = ((state.draft.boundaries.endFrame ?? (bounds ? item.startFrame + bounds.end : item.endFrame)) / item.rate).toFixed(6);
        const points = item.admission?.correction?.transients || item.preparation?.attacks?.accepted?.map(at => at+item.startFrame) || item.transients;
        $('admission-transients').value = points.map(at => (at/item.rate).toFixed(6)).join(', ');
        $('admission-root').value = item.admission?.correction?.root ?? item.root ?? '';
        $('admission-beats').value = item.admission?.correction?.beats ?? item.preparation?.phrase?.pulses ?? '';
        $('admission-status').textContent = '';
        $('precise-cuts').open = (item.preparation?.reasons || []).some(reason=>/loop|attack/.test(reason));
        $('sound-corrections').open = (item.preparation?.reasons || []).some(reason=>/loop|root|attack/.test(reason));
        $('loop').checked=loop;
        try {
            const saved=JSON.parse(localStorage.getItem(draftKey(state)) || 'null');
            if(saved) { for(const name of ['root','beats','transients']) { if(typeof saved[name]==='string'){ $('admission-'+name).value=saved[name]; } } }
        } catch(_) { /* Correction drafts are optional. */ }
    } else if (boundsSignature!==observedBounds) {
        $('admission-start').value = ((state.draft.boundaries.attackFrame ?? item.startFrame)/item.rate).toFixed(6);
        $('admission-end').value = ((state.draft.boundaries.endFrame ?? item.endFrame)/item.rate).toFixed(6);
    }
    observedBounds=boundsSignature;
    for (const name of ['approve','reject','save','bounds']) { $('admission-'+name).disabled = busy; }
}

export async function curateCurrent(decision) {
    return action(async ({state,setBounds,advance,persist,queue})=>{
        const item=state.current;
        if(!item) { return; }
        state.saving=true;
        try {
        const previousQueue=queue();
        if(decision==='later') { persist();state.saving=false;await advanceLater(state,previousQueue);return; }
        if(decision==='add' && !state.draft.tags.length) { throw Error('Choose a category before approving this sound'); }
        const rate=item.rate, start=Math.round(Number($('admission-start').value)*rate), end=Math.round(Number($('admission-end').value)*rate);
        if(decision==='add') {
            if(!Number.isInteger(start) || !Number.isInteger(end) || start<0 || end<=start || end>item.sourceFrames || end-start>=rate*60) { throw Error('Mark a valid start and end shorter than 60 seconds'); }
            setBounds({attackFrame:start,endFrame:end});
        }
        const candidates=$('admission-transients').value.split(/[\s,]+/).filter(Boolean).map(value=>Math.round(Number(value)*rate));
        if(decision==='add' && candidates.some(frame=>!Number.isFinite(frame))) { throw Error('Enter valid chop positions'); }
        const transients=candidates.filter(frame=>frame>=start && frame<end);
        if(decision==='add' && state.draft.tags.includes('drums') && (!transients.length || candidates[0]<start) && transients[0]!==start) { transients.unshift(start); }
        const root=$('admission-root').value==='' ? null : Number($('admission-root').value), beats=$('admission-beats').value==='' ? null : Number($('admission-beats').value);
        if(decision==='add' && state.draft.tags.includes('loops') && (!Number.isInteger(beats) || beats<2 || beats>128)) { throw Error('Enter the beat count for the marked loop'); }
        if(decision==='add' && (item.preparation?.reasons || []).includes('uncertain-root') && root===null) { throw Error('Enter the corrected MIDI root note'); }
        const draft=structuredClone(state.draft);
        draft.certainty=decision==='add' || draft.tags.length ? 'clear' : 'unsure';draft.quality=decision==='add' ? 'keep' : 'reject';
        const saved=await window.egcReview.request('/api/review/'+item.id,draft);
        await window.egcReview.request('/api/'+(decision==='add'?'admit/':'withhold/')+item.id,
            {reviewedAt:saved.comparison.reviewedAt,transients,root,beats});
        try { localStorage.removeItem(draftKey(state)); } catch(_) { /* Optional browser drafts. */ }
        state.saving=false;
        await advance(previousQueue);
        $('admission-status').textContent=decision==='add' ? 'Sound added. Counts updated; continue with the next item.' : 'Sound rejected and excluded. Continue with the next item.';
        } finally { state.saving=false; }
    });
}

async function advanceLater(state,previousQueue) {
    const index=previousQueue.indexOf(state.current.id), next=previousQueue[(index+1)%previousQueue.length];
    if(next && next!==state.current.id) {
        const button=[...document.querySelectorAll('#queue .queue-item')].find(button=>button.dataset.reviewId===next);
        button?.click();
    }
    $('admission-status').textContent='Draft kept. This sound is still waiting for a decision.';
}
for(const [id,decision] of [['curate-add','add'],['curate-exclude','reject'],['curate-later','later']]) {
    $(id).addEventListener('click',()=>curateCurrent(decision));
}

$('admission-audition').addEventListener('click',()=>action(async ({state})=>{
    const response = await window.egcReview.audio('/api/published/'+state.current.id);
    if (playerUrl) { URL.revokeObjectURL(playerUrl); }
    playerUrl = URL.createObjectURL(await response.blob());
    $('admission-player').src = playerUrl; $('admission-player').loop = state.draft.tags.includes('loops');
    $('admission-player').hidden = false;
}));

async function action(operation) {
    if (!context || busy) { return; }
    busy = true;
    $('review-app').inert=true;$('library-dashboard').inert=true;
    const current = context;
    for (const name of ['approve','reject','save','bounds']) { $('admission-'+name).disabled = true; }
    for(const id of ['curate-add','curate-exclude','curate-later']) { $(id).disabled=true; }
    try { await operation(current); }
    catch (error) { $('admission-status').textContent = error.message; }
    finally {
        busy = false;
        $('review-app').inert=false;$('library-dashboard').inert=false;
        for (const name of ['approve','reject','save','bounds']) { $('admission-'+name).disabled = false; }
        for(const id of ['curate-add','curate-exclude','curate-later']) { $(id).disabled=false; }
    }
}

$('admission-bounds').addEventListener('click', () => {
    if (!context) { return; }
    const rate = context.state.current.rate;
    const attackFrame=Math.round(Number($('admission-start').value)*rate),endFrame=Math.round(Number($('admission-end').value)*rate);
    context.setBounds({attackFrame,endFrame});
    $('admission-transients').value = $('admission-transients').value.split(/[\s,]+/).filter(Boolean).filter(value=>{
        const frame=Math.round(Number(value)*rate);return !Number.isFinite(frame) || frame>=attackFrame && frame<endFrame;
    }).join(', ');
    $('admission-status').textContent = 'Bounds applied. Audition the marks and loop join, then save your judgement.';
});
$('admission-save').addEventListener('click', () => action(async ({state,refresh}) => {
    await window.egcReview.request('/api/review/'+state.current.id,state.draft);
    state.drafts.delete(state.current.id); state.dirty = false;
    await refresh(); $('admission-status').textContent = 'Judgement saved. Library approval is a separate action.';
}));
for (const [name,route] of [['approve','admit'],['reject','withhold']]) {
    $('admission-'+name).addEventListener('click', () => action(async ({state,refresh}) => {
        if (state.dirty || !state.current.review) { throw new Error('Save the current judgement here before changing library approval'); }
        const rate = state.current.rate;
        if (name==='approve' && (Math.round(Number($('admission-start').value)*rate)!==(state.current.review.boundaries?.attackFrame ?? state.current.startFrame) ||
            Math.round(Number($('admission-end').value)*rate)!==(state.current.review.boundaries?.endFrame ?? state.current.endFrame))) {
            throw new Error('Apply the edited bounds to the waveform marks and save the judgement first');
        }
        const transients = $('admission-transients').value.trim() ? $('admission-transients').value.split(/[\s,]+/).filter(Boolean).map(value => {
            const number = Number(value);
            if (!Number.isFinite(number)) { throw new Error('Enter valid chop positions in source seconds'); }
            return Math.round(number*rate);
        }) : [];
        const value = {reviewedAt:state.current.review.updatedAt,transients,
            root:$('admission-root').value === '' ? null : Number($('admission-root').value),
            beats:$('admission-beats').value === '' ? null : Number($('admission-beats').value)};
        const result = await window.egcReview.request('/api/'+route+'/'+state.current.id,value);
        await refresh();
        $('admission-status').textContent = result.published ? 'Corrected sound added to the playable library. Save updated metadata in download mode.' : 'Sound excluded. Its audio and review remain available.';
    }));
}
