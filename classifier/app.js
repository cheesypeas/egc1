import {Folder, metadataZip} from './storage.js';
import {audioInfo, readWav} from './audio.js';
import {destination} from './taxonomy.js';

const $ = selector => document.querySelector(selector);
const number = value => (value || 0).toLocaleString();
const bytes = value => `${(value / 1048576).toFixed(1)} MiB`;
const time = seconds => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const basename = path => path.split('/').pop();
const rows = new Map(), analyses = new Map(), outputs = new Map();
let handle = null, files = [], folderName = '', worker = null, running = false, paused = false, report = null;
let total = 0, done = 0, within = 0, started = 0, stoppedAt = 0, timer = null, activeFilter = 'All', page = 0, selected = null;
let context = null, source = null, buffer = null, playStarted = 0, playOffset = 0, playEnd = 0, playing = false, animation = null;
let renderQueued = false, previewSequence = 0;
const PAGE_SIZE = 30;
const filterNames = ['All', 'Drums', 'Loops', 'Synth', 'Voice', 'FX', 'Uncertain', 'Attention', 'Failed'];
const sourceKind = row => row.browserKind === 'hit' ? 'Kit hit' : row.provenance?.kind === 'separated' ? 'Separated region' : 'Whole file';
const manualCategories = [
    ['Drums · unspecified hit', ['drums']], ['Drums · kick', ['drums', 'kick']], ['Drums · snare', ['drums', 'snare']],
    ['Drums · clap', ['drums', 'clap']], ['Drums · hi-hat', ['drums', 'hat']], ['Drums · tom', ['drums', 'tom']],
    ['Drums · cymbal', ['drums', 'cymbal']], ['Drums · percussion', ['drums', 'percussion']],
    ['Loops · drums', ['loops', 'drum-loop']], ['Loops · melodic', ['loops', 'melodic-loop']], ['Loops · vocal', ['loops', 'vocal-loop']],
    ['Synth · bass', ['synth', 'bass']], ['Synth · lead', ['synth', 'lead']], ['Synth · pad', ['synth', 'pad']],
    ['Synth · keys / piano', ['synth', 'keys']], ['Synth · unspecified instrument', ['synth']],
    ['Voice · short sung note', ['vocal', 'vocal-note']], ['Voice · speech / singing', ['vocal']],
    ['Effects / ambience', ['fx']], ['Uncertain', ['unclassified']],
];

function notice(message, error = false) {
    const element = $('#notice'); element.hidden = !message; element.textContent = message;
    element.classList.toggle('error', error);
}
function log(message, error = false) {
    const item = document.createElement('li'); item.textContent = message;
    if (error) { item.classList.add('error'); }
    $('#event-log').prepend(item);
    while ($('#event-log').children.length > 120) { $('#event-log').lastElementChild.remove(); }
    $('#log-count').textContent = `(${Math.min(120, $('#event-log').children.length)})`;
}
function folderSelected() {
    if (worker) { worker.terminate(); worker = null; }
    stopPlayback();
    rows.clear(); analyses.clear(); outputs.clear(); report = null; paused = false; page = 0;
    $('#results').hidden = true; $('#processing').hidden = true; $('#audition').hidden = true;
    document.body.classList.remove('has-player');
    $('#folder-name').textContent = folderName;
    $('#folder-description').textContent = handle ? 'Ready to scan this folder and its subfolders.' : `${number(files.length)} files selected · subfolders included.`;
    $('#choose-folder').textContent = 'change folder ↗';
    $('#folder-status').textContent = handle ? 'metadata will be saved to this folder' : 'metadata will be available as a ZIP download';
    $('#folder-status-dot').classList.remove('dim');
    $('#save-mode').textContent = handle ? 'SAVE TO FOLDER' : 'DOWNLOAD MODE';
    $('#run').disabled = false; $('#run').textContent = 'prepare samples →';
    $('#folder-note').textContent = handle ? 'Only .toysampler metadata and derived audio are written. Your original files stay untouched.' :
        'This browser cannot save directly to your folder. Download the metadata ZIP when finished, then extract it into this same folder.';
    notice(''); setSteps('choose');
}
async function chooseFolder() {
    if (running) { return; }
    if (window.showDirectoryPicker && window.isSecureContext) {
        try {
            const selected = await window.showDirectoryPicker({id: 'egc-samples', mode: 'readwrite'});
            handle = selected; files = []; folderName = selected.name; folderSelected();
        } catch (error) { if (error.name !== 'AbortError') { notice('The folder could not be opened. Check its permissions and try again.', true); } }
    } else { $('#folder-input').click(); }
}
$('#choose-folder').addEventListener('click', chooseFolder);
$('#folder-input').addEventListener('change', event => {
    const chosen = [...event.target.files];
    if (!chosen.length) { return; }
    folderName = chosen[0].webkitRelativePath.split('/')[0] || 'samples';
    files = chosen.map(file => ({path: file.webkitRelativePath.split('/').slice(1).join('/') || file.name, file}));
    handle = null; folderSelected();
});
for (const type of ['dragenter', 'dragover']) {
    $('#drop-zone').addEventListener(type, event => { event.preventDefault(); if (!running) { $('#drop-zone').classList.add('dragging'); } });
}
for (const type of ['dragleave', 'drop']) { $('#drop-zone').addEventListener(type, event => { event.preventDefault(); $('#drop-zone').classList.remove('dragging'); }); }
$('#drop-zone').addEventListener('drop', async event => {
    if (running) { return; }
    const item = event.dataTransfer.items[0];
    if (item?.getAsFileSystemHandle) {
        try {
            const dropped = await item.getAsFileSystemHandle();
            if (dropped?.kind !== 'directory') { notice('Drop a folder, or use “choose folder”.'); return; }
            const permission = await dropped.requestPermission({mode: 'readwrite'});
            if (permission !== 'granted') { notice('Choose the folder with the button to grant save permission.'); return; }
            handle = dropped; files = []; folderName = dropped.name; folderSelected();
        } catch (error) { notice('Use “choose folder” to open this directory.', true); }
    } else { notice('Use “choose folder” to include all subfolders.'); }
});

function setSteps(current) {
    const order = ['choose', 'process', 'review'];
    order.forEach((name, index) => {
        const element = $(`#step-${name}`);
        element.classList.toggle('current', name === current);
        element.classList.toggle('done', index < order.indexOf(current));
    });
}
function setRunning(value) {
    running = value;
    $('#choose-folder').disabled = value; $('#options').disabled = value; $('#force').disabled = value;
    $('#run').disabled = value || (!handle && !files.length);
    $('#pause').hidden = !value; $('#pause').disabled = false; $('#pause').textContent = 'pause';
    $('#activity-dot').classList.toggle('stopped', !value);
    $('#save-correction').disabled = value;
    $('#edit-category').disabled = value;
    if (value) {
        started = Date.now(); stoppedAt = 0;
        timer = setInterval(updateElapsed, 1000);
    } else { clearInterval(timer); timer = null; stoppedAt = Date.now(); updateElapsed(); }
}
function updateElapsed() { $('#elapsed').textContent = time(((stoppedAt || Date.now()) - started) / 1000); }
function ensureWorker() {
    if (worker) { return worker; }
    worker = new Worker(new URL('./worker.js', import.meta.url), {type: 'module'});
    worker.addEventListener('message', event => { void receive(event.data); });
    worker.addEventListener('error', event => { worker.terminate(); worker = null; finishError(event.message || 'The analysis worker stopped. Reload and run this folder again; completed metadata is reusable.'); });
    return worker;
}
function finishError(message) {
    setRunning(false); paused = true;
    $('#stage').textContent = 'processing stopped'; $('#download').hidden = true;
    $('#run').textContent = 'retry / resume →';
    notice(message, true); log(message, true);
    if (!handle && outputs.size) { $('#export-metadata').hidden = false; $('#results').hidden = false; }
}
$('#run').addEventListener('click', () => {
    if (running || (!handle && !files.length)) { return; }
    notice('');
    if (!paused) { rows.clear(); analyses.clear(); report = null; }
    done = 0; within = 0; total = 0;
    $('#processing').hidden = false; $('#stage').textContent = 'finding your samples'; $('#current-file').textContent = folderName;
    $('#progress-count').textContent = 'scanning folders…'; $('#progress-percent').textContent = '—'; $('#progress-fill').style.width = '0%';
    $('#accessible-progress').value = 0; $('#export-metadata').hidden = true; $('#download').hidden = true;
    setRunning(true); setSteps('process');
    const inputs = handle ? [] : [...new Map([...files.map(({path, file}) => [path, file]), ...outputs])].map(([path, file]) => ({path, file}));
    ensureWorker().postMessage({type: 'run', handle, files: inputs,
        options: {hints: $('#use-hints').checked, split: $('#split-regions').checked, beats: $('#find-beats').checked, kits: $('#make-kits').checked, force: $('#force').checked},
        localModels: new URLSearchParams(location.search).get('models') === 'local' && ['localhost', '127.0.0.1'].includes(location.hostname)});
    log(`Started ${folderName}. Originals are preserved.`);
});
$('#pause').addEventListener('click', () => {
    if (!running) { return; }
    worker.postMessage({type: 'pause'});
    $('#pause').textContent = 'pausing after this sample…'; $('#pause').disabled = true;
    $('#progress-summary').textContent = 'Finishing the current sample and saving its completed results.';
});

async function receive(data) {
    if (data.type === 'decode') {
        try {
            const offline = new OfflineAudioContext(2, 1, data.rate);
            const decoded = await offline.decodeAudioData(await data.file.arrayBuffer());
            const channels = Array.from({length: decoded.numberOfChannels}, (_, ch) => decoded.getChannelData(ch).slice());
            worker.postMessage({type: 'decoded', token: data.token, channels}, channels.map(ch => ch.buffer));
        } catch (error) { worker.postMessage({type: 'decoded', token: data.token, error: 'This browser cannot decode the file. Convert it to PCM WAV and retry.'}); }
        return;
    }
    if (data.type === 'output') { outputs.set(data.path, data.blob); return; }
    if (data.type === 'scanned') { total = data.total; updateProgress(); return; }
    if (data.type === 'file') { $('#current-file').textContent = data.path; return; }
    if (data.type === 'stage') {
        $('#stage').textContent = data.stage.toLowerCase(); $('#download').hidden = true; return;
    }
    if (data.type === 'download') {
        $('#stage').textContent = 'downloading models · first run'; $('#download').hidden = false;
        $('#download-name').textContent = data.name.toLowerCase(); $('#download-size').textContent = `${bytes(data.loaded)} / ${bytes(data.total)}`;
        $('#download-progress').value = 100 * data.loaded / data.total; return;
    }
    if (data.type === 'notice') { notice(data.message); log(data.message); return; }
    if (data.type === 'error') { finishError(data.message); return; }
    if (data.type === 'result') {
        rows.set(data.row.path, {...data.row, cached: data.cached, feedback: data.feedback});
        if (data.analysis) { analyses.set(data.row.id, data.analysis); }
        $('#results').hidden = false;
        if (data.row.state === 'failed') { log(`${data.row.path}: ${data.row.error}`, true); }
        scheduleRender(); return;
    }
    if (data.type === 'kit') {
        for (const row of rows.values()) { if (row.id === data.sourceId) { row.kitHits = data.count; } }
        scheduleRender(); return;
    }
    if (data.type === 'progress') {
        done = data.completed; within = data.within; total = data.total; report = data.report;
        updateProgress(); scheduleRender(); return;
    }
    if (data.type === 'complete' || data.type === 'paused') {
        report = data.report;
        for (const row of data.rows) { rows.set(row.path, {...rows.get(row.path), ...row}); }
        setRunning(false); paused = data.type === 'paused'; $('#download').hidden = true;
        $('#run').textContent = paused ? 'resume processing →' : 'run again →';
        $('#stage').textContent = paused ? 'paused · your progress is saved' : report.failures.length ? 'finished · some files need attention' : 'your samples are ready';
        $('#progress-summary').textContent = handle ? 'Metadata saved in .toysampler alongside your audio.' : 'Download the metadata ZIP and extract it into your sample folder.';
        $('#export-metadata').hidden = Boolean(handle) || outputs.size === 0;
        $('#results').hidden = false;
        done = report.completedFiles; within = 0;
        updateProgress(); render(); setSteps(paused ? 'process' : 'review');
        const status = paused ? 'Paused' : 'Finished';
        log(`${status}: ${number(report.readySamples)} sounds, ${number(report.reusedEmbeddings)} reused embeddings, ${number(report.failures.length)} failures.`);
        if (!handle) { notice('Save your results: download the metadata ZIP, then extract its .toysampler folder into your selected sample folder.'); }
        return;
    }
    if (data.type === 'corrected') {
        for (const row of rows.values()) { if (row.id === data.id) { row.tags = data.tags; row.tagsSource = 'manual'; row.needsReview = false; } }
        if (selected?.id === data.id) { selected.tags = data.tags; selected.tagsSource = 'manual'; updatePlayerMeta(); }
        $('#correction').hidden = true; $('#save-correction').disabled = false;
        notice(handle ? 'Manual category saved. It will take priority on future runs.' : 'Manual category saved to this export. Download the updated metadata ZIP.');
        render();
    }
}
function updateProgress() {
    const progress = total ? Math.max(0, Math.min(100, 100 * (done + within) / total)) : 0;
    $('#progress-fill').style.width = `${progress}%`; $('#accessible-progress').value = progress;
    $('#progress-count').textContent = total ? `${number(done)} / ${number(total)} source files${report ? ` · ${number(report.readySamples)} sounds ready` : ''}` : 'scanning folders…';
    $('#progress-percent').textContent = total ? `${Math.floor(progress)}%` : '—';
    if (running && !$('#pause').disabled && report) { $('#progress-summary').textContent = `${number(report.reusedEmbeddings)} reused · ${number(report.newEmbeddings)} newly classified${report.failures.length ? ` · ${number(report.failures.length)} not processed` : ''}`; }
}
function scheduleRender() { if (!renderQueued) { renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); } }
function isUncertain(row) { return row.tags?.includes('unclassified') || row.browserRoleEvidence?.mode === 'alternatives'; }
function matches(row, filter) {
    if (filter === 'All') { return true; }
    if (filter === 'Failed') { return row.state === 'failed'; }
    if (filter === 'Attention') { return Boolean(row.feedback?.needsAttention); }
    if (filter === 'Uncertain') { return row.state === 'ready' && isUncertain(row); }
    return row.state === 'ready' && destination(row.tags) === filter;
}
function render() {
    const all = [...rows.values()], ready = all.filter(row => row.state === 'ready');
    $('#stat-ready').textContent = number(ready.length);
    $('#stat-cached').textContent = number(ready.filter(row => row.cached).length);
    $('#stat-regions').textContent = number(ready.filter(row => row.provenance?.kind === 'separated').length);
    $('#stat-kits').textContent = number(report?.kits || 0); $('#stat-failed').textContent = number(report?.failures.length || all.filter(row => row.state === 'failed').length);
    $('#failed-stat').classList.toggle('has-failures', Boolean(report?.failures.length));
    $('#kit-detail').textContent = report?.hits ? `${number(report.hits)} extracted hits` : 'drum hit collections';
    const filters = $('#filters'); filters.replaceChildren();
    for (const name of filterNames) {
        const count = all.filter(row => matches(row, name)).length;
        if (!count && name !== 'All' && activeFilter !== name) { continue; }
        const button = document.createElement('button'); button.type = 'button'; button.className = `filter${name === activeFilter ? ' active' : ''}`;
        button.setAttribute('aria-pressed', name === activeFilter ? 'true' : 'false'); button.append(document.createTextNode(name.toLowerCase()));
        const badge = document.createElement('span'); badge.textContent = number(count); button.append(badge);
        button.addEventListener('click', () => { activeFilter = name; page = 0; render(); }); filters.append(button);
    }
    const query = $('#search').value.trim().toLowerCase();
    const filtered = all.filter(row => matches(row, activeFilter) && (!query || `${row.path} ${row.provenance?.sourcePath || ''} ${(row.tags || []).join(' ')} ${row.error || ''}`.toLowerCase().includes(query)));
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)); page = Math.min(page, pages - 1);
    const tbody = $('#result-rows'); tbody.replaceChildren();
    for (const row of filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
        const tr = document.createElement('tr'); tr.classList.toggle('selected', selected?.path === row.path);
        const play = document.createElement('td'), button = document.createElement('button');
        button.type = 'button'; button.className = 'row-play'; button.textContent = '▶'; button.disabled = row.state !== 'ready'; button.setAttribute('aria-label', `Play ${basename(row.path)}`);
        button.addEventListener('click', event => { event.stopPropagation(); void selectSound(row, true); }); play.append(button);
        const name = document.createElement('td'), title = document.createElement('span'), path = document.createElement('span');
        title.className = 'sample-name'; title.textContent = basename(row.provenance?.sourcePath || row.path);
        if (row.provenance) { title.textContent += ` · ${(row.provenance.start / row.rate).toFixed(2)} s`; }
        path.className = 'sample-path'; path.textContent = row.error || row.provenance?.sourcePath || row.path;
        name.title = path.textContent; name.append(title, path);
        const category = document.createElement('td'), tags = document.createElement('div'); tags.className = 'tags';
        if (row.state === 'failed') { const tag = document.createElement('span'); tag.className = 'tag failed'; tag.textContent = 'not processed'; tags.append(tag); }
        else {
            const family = row.tags.find(tag => ['drums', 'loops', 'synth', 'vocal', 'fx', 'unclassified'].includes(tag)) || 'unclassified';
            for (const value of row.tags.filter(tag => tag !== 'recorded')) {
                const tag = document.createElement('span'); tag.className = `tag ${family}`; tag.textContent = value === 'unclassified' ? 'uncertain' : value; tags.append(tag);
            }
            if (row.tagsSource === 'manual') { const tag = document.createElement('span'); tag.className = 'tag manual'; tag.textContent = 'edited'; tags.append(tag); }
        }
        category.append(tags);
        const origin = document.createElement('td'); origin.className = 'source-type'; origin.textContent = row.state === 'failed' ? '—' : sourceKind(row);
        if (row.kitHits) { origin.textContent += ` · ${row.kitHits}-hit kit`; }
        const duration = document.createElement('td'); duration.className = 'duration-cell'; duration.textContent = row.samples && row.rate ? `${(row.samples / row.rate).toFixed(2)}s` : '—';
        const status = document.createElement('td'); status.className = 'row-state';
        if (row.feedback?.needsAttention) { status.textContent = '!'; status.title = 'Marked for attention on the instrument'; status.classList.add('attention'); }
        else if (row.feedback?.favourite) { status.textContent = '★'; status.title = 'Favourite on the instrument'; status.classList.add('favourite'); }
        else if (row.cached) { status.textContent = '↻'; status.title = 'Reused saved analysis'; }
        tr.append(play, name, category, origin, duration, status);
        tr.addEventListener('click', () => { if (row.state === 'ready') { void selectSound(row, false); } else { notice(`${row.path}: ${row.error}`, true); } });
        tbody.append(tr);
    }
    $('#empty-results').hidden = filtered.length > 0;
    $('#showing').textContent = filtered.length ? `${number(page * PAGE_SIZE + 1)}–${number(Math.min(filtered.length, (page + 1) * PAGE_SIZE))} of ${number(filtered.length)} sounds` : '0 sounds';
    $('#page-label').textContent = `${page + 1} / ${pages}`; $('#previous-page').disabled = page === 0; $('#next-page').disabled = page >= pages - 1;
}
$('#search').addEventListener('input', () => { page = 0; render(); });
$('#previous-page').addEventListener('click', () => { page = Math.max(0, page - 1); render(); });
$('#next-page').addEventListener('click', () => { page++; render(); });

function download(blob, name) {
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
$('#export-report').addEventListener('click', () => {
    download(new Blob([JSON.stringify({...report, results: [...rows.values()].map(({cached, feedback, ...row}) => row)}, null, 2) + '\n'], {type: 'application/json'}), 'sample-lab-report.json');
});
$('#export-metadata').addEventListener('click', async () => {
    const button = $('#export-metadata'); button.disabled = true;
    try {
        button.textContent = 'preparing ZIP…';
        const blob = await metadataZip(outputs, fraction => { button.textContent = `preparing ZIP · ${Math.floor(fraction * 100)}%`; });
        download(blob, 'toysampler-metadata.zip'); notice('Extract the ZIP into the selected sample folder. It contains .toysampler metadata and derived sounds; no original audio is included.');
    } catch (error) { notice(error.message, true); }
    finally { button.disabled = false; button.textContent = 'download metadata ↓'; }
});

function getFolder() { const folder = new Folder(handle, files); folder.outputs = outputs; return folder; }
function audioContext() { if (!context) { context = new AudioContext(); } return context; }
function stopPlayback() {
    if (source) { source.onended = null; try { source.stop(); } catch (_) {} source.disconnect(); source = null; }
    playing = false; if (animation) { cancelAnimationFrame(animation); animation = null; }
    $('#player-play').textContent = '▶'; $('#player-play').setAttribute('aria-label', 'Play selected sample');
}
function updatePlayerMeta() {
    $('#player-name').textContent = basename(selected.provenance?.sourcePath || selected.path);
    $('#player-info').textContent = `${sourceKind(selected).toLowerCase()} · ${selected.tags.join(' / ')}${selected.tagsSource === 'manual' ? ' · edited' : ''}`;
}
async function selectSound(row, autoplay) {
    const seq = ++previewSequence;
    if (autoplay) { await audioContext().resume(); }
    stopPlayback(); selected = row; buffer = null; playOffset = 0;
    $('#audition').hidden = false; $('#correction').hidden = true; document.body.classList.add('has-player');
    updatePlayerMeta(); $('#player-time').textContent = 'loading…'; $('#player-play').disabled = true;
    $('#player-loop').checked = row.tags.includes('loops');
    $('#edit-category').disabled = running; render();
    try {
        const folder = getFolder(), file = await folder.file(row.path);
        if (!file) { throw new Error('The audio file is no longer available. Select the folder again.'); }
        const info = await audioInfo(file);
        let channels;
        if (info.compressed) {
            const offline = new OfflineAudioContext(2, 1, info.rate);
            const decoded = await offline.decodeAudioData(await file.arrayBuffer());
            channels = Array.from({length: decoded.numberOfChannels}, (_, ch) => decoded.getChannelData(ch));
        } else { channels = await readWav(file, info); }
        if (seq !== previewSequence) { return; }
        buffer = audioContext().createBuffer(channels.length, channels[0].length, info.rate);
        channels.forEach((channel, index) => { buffer.copyToChannel(channel, index); });
        let analysis = analyses.get(row.id);
        if (!analysis) { analysis = await folder.json(`.toysampler/entries/${row.id}.json`); if (analysis) { analyses.set(row.id, analysis); } }
        if (seq !== previewSequence) { return; }
        playEnd = row.tags.includes('loops') && analysis?.loop?.loopEndSample > 0 ? Math.min(buffer.duration, analysis.loop.loopEndSample / info.rate) : buffer.duration;
        $('#player-play').disabled = false; $('#player-time').textContent = `0.00 / ${playEnd.toFixed(2)}`;
        drawWaveform();
        if (autoplay) { startPlayback(0); }
    } catch (error) { notice(`Could not audition this sample: ${error.message}`, true); $('#player-time').textContent = 'unavailable'; }
}
function startPlayback(offset = playOffset) {
    if (!buffer) { return; }
    stopPlayback();
    source = context.createBufferSource(); source.buffer = buffer;
    source.loop = $('#player-loop').checked; source.loopStart = 0; source.loopEnd = playEnd;
    source.connect(context.destination);
    playOffset = Math.max(0, Math.min(offset, playEnd - 1 / buffer.sampleRate)); playStarted = context.currentTime;
    if (source.loop) { source.start(0, playOffset); } else { source.start(0, playOffset, playEnd - playOffset); }
    source.onended = () => { playing = false; source = null; playOffset = 0; $('#player-play').textContent = '▶'; $('#player-play').setAttribute('aria-label', 'Play selected sample'); };
    playing = true; $('#player-play').textContent = 'Ⅱ'; $('#player-play').setAttribute('aria-label', 'Pause selected sample'); tickPlayback();
}
function tickPlayback() {
    if (!playing || !buffer) { return; }
    const at = (playOffset + context.currentTime - playStarted) % playEnd;
    $('#wave-playhead').style.left = `${100 * at / buffer.duration}%`;
    $('#player-time').textContent = `${at.toFixed(2)} / ${playEnd.toFixed(2)}`;
    animation = requestAnimationFrame(tickPlayback);
}
$('#player-play').addEventListener('click', async () => {
    if (!buffer) { return; }
    await audioContext().resume();
    if (playing) { const at = (playOffset + context.currentTime - playStarted) % playEnd; stopPlayback(); playOffset = at; }
    else { startPlayback(); }
});
$('#player-loop').addEventListener('change', () => { if (playing) { const at = (playOffset + context.currentTime - playStarted) % playEnd; startPlayback(at); } });
$('#close-player').addEventListener('click', () => { ++previewSequence; stopPlayback(); $('#audition').hidden = true; document.body.classList.remove('has-player'); });
$('#waveform').addEventListener('click', async event => {
    if (!buffer) { return; }
    await audioContext().resume();
    const rect = $('#waveform').getBoundingClientRect(); const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    startPlayback(Math.min(playEnd - .0001, fraction * buffer.duration));
});
function drawWaveform() {
    const canvas = $('#waveform'), ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!buffer) { return; }
    const channels = Array.from({length: buffer.numberOfChannels}, (_, ch) => buffer.getChannelData(ch));
    ctx.strokeStyle = '#72a876'; ctx.lineWidth = 1;
    for (let x = 0; x < canvas.width; x++) {
        const left = Math.floor(x * buffer.length / canvas.width), right = Math.max(left + 1, Math.floor((x + 1) * buffer.length / canvas.width));
        let magnitude = 0;
        for (const channel of channels) { for (let i = left; i < Math.min(right, channel.length); i++) { magnitude = Math.max(magnitude, Math.abs(channel[i])); } }
        const height = Math.max(1, Math.min(1, magnitude) * canvas.height * .46);
        ctx.beginPath(); ctx.moveTo(x + .5, canvas.height / 2 - height); ctx.lineTo(x + .5, canvas.height / 2 + height); ctx.stroke();
    }
    const loop = analyses.get(selected.id)?.loop;
    ctx.strokeStyle = '#b7e59455';
    for (const sample of loop?.transients || []) {
        const x = sample / buffer.length * canvas.width; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    if (playEnd < buffer.duration) { ctx.fillStyle = '#dba35a22'; ctx.fillRect(playEnd / buffer.duration * canvas.width, 0, canvas.width, canvas.height); }
    $('#wave-playhead').style.left = '0%';
}
for (const [name, tags] of manualCategories) { $('#correct-tags').add(new Option(name, JSON.stringify(tags))); }
$('#edit-category').addEventListener('click', () => {
    if (!selected || running) { return; }
    const current = JSON.stringify(selected.tags.filter(t => t !== 'recorded'));
    $('#correct-tags').value = manualCategories.some(([, tags]) => JSON.stringify(tags) === current) ? current : JSON.stringify(['unclassified']);
    $('#correction').hidden = !$('#correction').hidden;
});
$('#cancel-correction').addEventListener('click', () => { $('#correction').hidden = true; });
$('#correction').addEventListener('submit', event => {
    event.preventDefault(); if (!selected || running) { return; }
    const tags = JSON.parse($('#correct-tags').value);
    if (selected.tags.includes('recorded')) { tags.push('recorded'); }
    $('#save-correction').disabled = true;
    worker.postMessage({type: 'correct', id: selected.id, tags});
});
document.addEventListener('keydown', event => {
    if (event.code === 'Space' && !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement.tagName) && !$('#audition').hidden) {
        event.preventDefault(); $('#player-play').click();
    }
});
window.addEventListener('beforeunload', event => { if (running) { event.preventDefault(); event.returnValue = ''; } });

if (!window.showDirectoryPicker) {
    $('#folder-note').textContent = 'Choose a folder to process locally and download its metadata. Chrome/Edge can also save results directly into the folder.';
}
if (!window.Worker || !window.WebAssembly || !window.crypto?.subtle || !navigator.locks) {
    $('#choose-folder').disabled = true;
    notice('This browser is missing a required local-processing feature. Open this page in a current desktop Chrome, Edge or Firefox.', true);
}
if ('serviceWorker' in navigator && !new URLSearchParams(location.search).has('no-sw')) {
    navigator.serviceWorker.addEventListener('message', ({data}) => {
        if (data?.type === 'offline-cache-error') { log(`Offline page caching failed: ${data.message}. Processing can continue online.`); }
    });
    navigator.serviceWorker.register('./sw.js').catch(() => { log('Offline page caching is unavailable; processing still works while this page is open.'); });
}
