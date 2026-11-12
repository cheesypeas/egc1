const $ = id => document.getElementById(id);
let context = null, selected = null, busy = false, playerUrl = null;

export function renderAdmission(state, refresh, setBounds) {
    context = {state,refresh,setBounds};
    const item = state.current;
    $('admission').hidden = !state.session.publicationSupported || !item;
    if ($('admission').hidden) { return; }
    $('admission-state').textContent = item.publication === 'ready' ? 'Included in the playable library' : 'Excluded from the playable library';
    $('admission-reasons').textContent = (item.preparation?.reasons || []).map(reason => reason.replaceAll('-', ' ')).join(' · ');
    $('admission-beats-label').hidden = !state.draft.tags.includes('loops');
    $('admission-audition').disabled = item.publication !== 'ready';
    if (selected !== item.id) {
        selected = item.id;
        $('admission-player').pause(); $('admission-player').hidden = true;
        if (playerUrl) { URL.revokeObjectURL(playerUrl); playerUrl = null; }
        const bounds = item.preparation?.bounds;
        $('admission-start').value = ((state.draft.boundaries.attackFrame ?? (bounds ? item.startFrame + bounds.start : item.startFrame)) / item.rate).toFixed(6);
        $('admission-end').value = ((state.draft.boundaries.endFrame ?? (bounds ? item.startFrame + bounds.end : item.endFrame)) / item.rate).toFixed(6);
        const points = item.admission?.correction?.transients || item.preparation?.attacks?.accepted?.map(at => at+item.startFrame) || item.transients;
        $('admission-transients').value = points.map(at => (at/item.rate).toFixed(6)).join(', ');
        $('admission-root').value = item.admission?.correction?.root ?? '';
        $('admission-beats').value = item.admission?.correction?.beats ?? item.preparation?.phrase?.pulses ?? '';
        $('admission-status').textContent = '';
    } else if (!state.dirty && item.review) {
        $('admission-start').value = ((item.review.boundaries?.attackFrame ?? item.startFrame)/item.rate).toFixed(6);
        $('admission-end').value = ((item.review.boundaries?.endFrame ?? item.endFrame)/item.rate).toFixed(6);
    }
    for (const name of ['approve','reject','save','bounds']) { $('admission-'+name).disabled = busy; }
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
    const current = context;
    for (const name of ['approve','reject','save','bounds']) { $('admission-'+name).disabled = true; }
    try { await operation(current); }
    catch (error) { $('admission-status').textContent = error.message; }
    finally {
        busy = false;
        for (const name of ['approve','reject','save','bounds']) { $('admission-'+name).disabled = false; }
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
