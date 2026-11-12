"use strict";

const $ = (id) => document.getElementById(id);
const categoryNames = { drums: "Drums", loops: "Loops", synth: "Synth", vocal: "Vocal", fx: "FX / other" };
const roleNames = { "drum-loop": "Drum loop", "melodic-loop": "Melodic loop", "vocal-loop": "Vocal loop",
  "vocal-note": "Short note / stab", hat: "Hi-hat" };
const roleKeys = ["q", "w", "e", "r", "t", "y", "u"];
const waveformCache = new WeakMap();
const zoomSteps = [.001, .002, .005, .012, .025, .05, .1, .25, .5, 1, 2, 5, "full"];
const state = {
  session: null, mode: "sample", filter: "unreviewed", current: null, draft: null,
  activeCategory: null, search: "", category: "", folder: "", reason: "", sort: "source", view: "primary", primary: null,
  original: null, context: null, gain: null, player: null, seek: 0,
  serial: 0, saving: false, drafts: new Map(), buffers: new Map(), bufferBytes: new Map(), ranges: {}, dirty: false, animation: null,
  centers: {}, waveFocus: {}, playbackSerial: 0, restartQueueAfterDraft: false,
};

function title(value) {
  return roleNames[value] || value.charAt(0).toUpperCase() + value.slice(1);
}

function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}

async function request(path, value) {
  if (window.egcReview) { return window.egcReview.request(path, value); }
  const options = value === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json", "X-Audition-Token": state.session.token },
    body: JSON.stringify(value),
  };
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) { throw new Error(result.error || "Could not contact the local auditioner"); }
  return result;
}

function allItems() {
  return state.session.items.filter((item) => item.kind === state.mode);
}

function itemTags(item) {
  return item.review?.tags?.length ? item.review.tags : item.currentTags || item.prediction || [];
}

function itemFolder(item) {
  return (item.sourcePath || item.filename || "").split("/").slice(0, -1).join("/");
}

function itemReasons(item) {
  return [...new Set([...(item.preparation?.reasons || []), ...(item.review?.reasons || []),
    ...(item.instrument?.needsAttention ? ["instrument-attention"] : [])])];
}

function itemLabel(item) {
  const name = (item.sourcePath || item.filename || item.id).split("/").pop();
  return item.origin === "separated" || item.kind === "hit" ? `${name} · ${item.startSeconds.toFixed(3)}–${item.endSeconds.toFixed(3)} s` : name;
}

function queueItems() {
  const terms = state.search.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const items = allItems().filter((item) => {
    const tags = itemTags(item), reasons = itemReasons(item);
    if (state.category && !tags.includes(state.category)) { return false; }
    if (state.folder && itemFolder(item) !== (state.folder === "__root__" ? "" : state.folder)) { return false; }
    if (state.reason && !reasons.includes(state.reason)) { return false; }
    const text = [item.filename, item.sourcePath, ...tags, ...tags.map(title), ...reasons, item.review?.notes].join(" ").toLowerCase();
    if (!terms.every(term => text.includes(term))) { return false; }
    if (state.filter === "pending") { return item.publication === "needs-review"; }
    if (state.filter === "accepted") { return item.publication === "ready"; }
    if (state.filter === "excluded") { return item.publication === "rejected"; }
    if (state.filter === "instrument") { return item.instrument?.needsAttention; }
    if (state.filter === "favourites") { return item.instrument?.favourite; }
    if (state.filter === "unreviewed") { return !item.review; }
    if (state.filter === "unsure") { return item.review && item.review.certainty !== "clear"; }
    if (state.filter === "rejected") { return item.review && item.review.quality === "reject"; }
    if (state.filter === "separated") { return item.origin === "separated"; }
    if (state.filter === "whole") { return item.kind === "sample" && item.origin !== "separated"; }
    return true;
  });
  const compare = (a, b) => a.localeCompare(b, undefined, {numeric:true, sensitivity:"base"});
  return items.sort((a,b) => {
    if (state.sort === "duration") { return a.duration-b.duration || compare(a.id,b.id); }
    if (state.sort === "longest") { return b.duration-a.duration || compare(a.id,b.id); }
    if (state.sort === "category") { const order = compare(itemTags(a).join("/"),itemTags(b).join("/")); if (order) { return order; } }
    return compare(a.sourcePath || a.filename || "",b.sourcePath || b.filename || "") || a.startFrame-b.startFrame || compare(a.id,b.id);
  });
}

function filterOptions(id, values, label) {
  const select = $(id), signature = JSON.stringify(values);
  if (select.dataset.values === signature) { return; }
  select.dataset.values = signature;
  select.replaceChildren(new Option(label, ""), ...values.map(([value,text]) => new Option(text,value)));
}

function renderOrganisation() {
  const items = state.session.items;
  filterOptions("category-filter", [...new Set(items.flatMap(itemTags))].sort().map(tag => [tag,title(tag)]), "All categories");
  filterOptions("folder-filter", [...new Set(items.map(itemFolder))].sort().map(folder => [folder || "__root__",folder || "Top level"]), "All folders");
  filterOptions("reason-filter", [...new Set(items.flatMap(itemReasons))].sort().map(reason => [reason,title(reason.replaceAll("-", " "))]), "All review reasons");
  $("category-filter").value = state.category;
  $("folder-filter").value = state.folder;
  $("reason-filter").value = state.reason;
  $("queue-search").value = state.search;
  $("queue-sort").value = state.sort;
  $("filter").value = state.filter;
  for (const option of $("filter").options) {
    option.hidden = ["pending","accepted","excluded"].includes(option.value) && !state.session.publicationSupported;
  }
}

function saveLocal() {
  try {
    localStorage.setItem("egc1-review:" + state.session.fingerprint, JSON.stringify({
      mode: state.mode, organisation:{filter:state.filter,search:state.search,category:state.category,folder:state.folder,reason:state.reason,sort:state.sort}, current: state.current?.id, drafts: Array.from(state.drafts), savedAt: Date.now(),
      queuePolicy: state.session.queuePolicy,
    }));
  } catch (_) { /* Durable judgements are on the server; browser preferences are optional. */ }
}

function rememberDraft() {
  if (state.current && state.dirty) {
    state.drafts.set(state.current.id, JSON.parse(JSON.stringify(state.draft)));
  }
  saveLocal();
}

function changed() {
  state.dirty = true;
  rememberDraft();
  status("Unsaved judgement · Enter saves and moves on.");
}

function renderQueue() {
  renderOrganisation();
  const items = allItems();
  const reviewed = items.filter((item) => state.session.publicationSupported ? item.publication === "ready" : item.review).length;
  $("progress-text").textContent = state.session.publicationSupported ? "included" : "reviewed";
  $("samples-count").textContent = state.session.items.filter((item) => item.kind === "sample").length;
  $("hits-count").textContent = state.session.items.filter((item) => item.kind === "hit").length;
  $("reviewed").textContent = reviewed;
  $("total").textContent = "/ " + items.length;
  $("progress").max = items.length || 1;
  $("progress").value = reviewed;
  $("samples-tab").classList.toggle("active", state.mode === "sample");
  $("hits-tab").classList.toggle("active", state.mode === "hit");
  $("undo").disabled = !state.session.canUndo || state.saving;
  $("library-info").textContent = `${state.session.fileCount} source files · ${state.session.packCount || 1} packs · ${state.session.items.filter((item) => item.kind === "sample").length} samples${state.session.processing ? " · processing…" : ""}${state.session.flagged ? ` · ${state.session.flagged} flagged imports` : ""}${state.session.skipped ? ` · ${state.session.skipped} unavailable` : ""}`;
  const classifier = state.session.classifier;
  $("classifier-info").textContent = classifier?.nameHints ?
    "Categories use filenames, folders and audio. Suggestions are provisional." : classifier?.method === "clap-onnx-v1" ?
    state.session.processing && classifier.total ? `Updating categories: ${classifier.done || 0} / ${classifier.total}. Finished suggestions are available.` :
    "Categories use audio recognition. Suggestions are provisional; unclassified means the model is unsure." :
    "Audio classification uses a pitch-only baseline. Unclassified means no category was assigned.";
  const visible = queueItems();
  $("queue-count").textContent = `${visible.length} shown · ${items.length} in this collection`;
  const queue = $("queue");
  queue.replaceChildren();
  for (const item of visible) {
    const button = document.createElement("button");
    button.className = "queue-item" + (item.id === state.current?.id ? " active" : "");
    const dot = document.createElement("span");
    dot.className = "state-dot" + (item.review ? item.review.certainty === "clear" ? " done" : " unsure" : "");
    const text = document.createElement("span");
    text.className = "queue-description";
    const name = document.createElement("strong"), detail = document.createElement("small"), location = document.createElement("small");
    name.textContent = itemLabel(item);
    detail.textContent = [...itemTags(item).map(title), item.publication === "needs-review" ? "Needs review" : item.publication === "rejected" ? "Excluded" : item.publication === "ready" ? "Included" : ""].filter(Boolean).join(" · ");
    location.textContent = itemFolder(item) || "Top level";
    text.append(name,detail,location);
    button.title = `${item.sourcePath || item.filename || ""}\n${itemReasons(item).join(", ")}`;
    const duration = document.createElement("small");
    duration.textContent = item.duration.toFixed(2) + " s";
    button.append(dot, text, duration);
    button.setAttribute("aria-current", item.id === state.current?.id ? "true" : "false");
    button.addEventListener("click", () => select(item));
    queue.append(button);
  }
}

function renderJudgement() {
  if (!state.current) { return; }
  const categories = $("categories");
  categories.replaceChildren();
  for (const [index, category] of Object.keys(categoryNames).entries()) {
    const button = document.createElement("button");
    const name = document.createElement("span");
    name.textContent = categoryNames[category];
    const key = document.createElement("kbd");
    key.textContent = index + 1;
    button.append(name, key);
    button.dataset.category = category;
    button.classList.toggle("selected", state.draft.tags.includes(category));
    button.setAttribute("aria-pressed", String(state.draft.tags.includes(category)));
    button.addEventListener("click", () => toggleCategory(category));
    categories.append(button);
  }
  const roles = $("roles");
  roles.replaceChildren();
  $("roles-title").textContent = state.activeCategory ? categoryNames[state.activeCategory] + " role" : "Choose a category to add a role";
  for (const [index, role] of (state.session.taxonomy[state.activeCategory] || []).entries()) {
    const button = document.createElement("button");
    button.textContent = title(role);
    const key = document.createElement("kbd");
    key.textContent = roleKeys[index].toUpperCase();
    button.append(key);
    button.dataset.role = role;
    button.classList.toggle("selected", state.draft.tags.includes(role));
    button.setAttribute("aria-pressed", String(state.draft.tags.includes(role)));
    button.addEventListener("click", () => toggleRole(role));
    roles.append(button);
  }
  const otherRoles = state.draft.tags.filter((tag) => !Object.keys(categoryNames).includes(tag) && !(state.session.taxonomy[state.activeCategory] || []).includes(tag));
  for (const role of otherRoles) {
    const button = document.createElement("button");
    button.textContent = title(role) + " ×";
    button.className = "selected chosen-other";
    button.addEventListener("click", () => { state.draft.tags = state.draft.tags.filter((tag) => tag !== role); changed(); renderJudgement(); });
    roles.append(button);
  }
  const instrument = state.current.instrument;
  $("instrument-feedback").hidden = !instrument?.needsAttention && !instrument?.favourite;
  $("instrument-feedback-text").textContent = [instrument?.favourite ? "Favourited on instrument" : "", instrument?.needsAttention ? "Needs attention · whole sample / kit" : ""].filter(Boolean).join(" · ");
  $("resolve-instrument").hidden = !instrument?.needsAttention;
  $("hit-quality").hidden = false;
  $("quality-title").textContent = state.mode === "hit" ? "Is this a useful extracted hit?" :
    state.current.origin === "separated" ? "Has the source been separated into the right pieces?" :
    "Does this file already contain one musical item? (optional)";
  $("quality-help").textContent = state.mode === "hit" ?
    "Judge whether extraction produced a useful drum hit. Use waveform marks for precise attack/end timing." :
    state.current.origin === "separated" ?
    "Five independent vocal stabs → five samples. One complete drum break → one loop. Judge the grouping here; mark exact timing in the waveforms." :
    "Choose Needs separating if independent sounds are bundled together. One complete phrase or loop counts as one item.";
  const qualityLabels = state.mode === "hit" ? {keep: "Useful hit ", reject: "Bad extraction ", unsure: "Unsure"} :
    state.current.origin === "separated" ? {keep: "Good separation ", reject: "Bad separation ", unsure: "Unsure"} :
    {keep: "One item ", reject: "Needs separating ", unsure: "Unsure"};
  $("not-drum-issue").hidden = state.mode !== "hit";
  for (const label of document.querySelectorAll("[data-region-issue]")) { label.hidden = state.mode === "hit"; }
  for (const button of document.querySelectorAll("[data-quality]")) {
    button.firstChild.textContent = qualityLabels[button.dataset.quality];
    button.classList.toggle("selected", button.dataset.quality === state.draft.quality);
    button.setAttribute("aria-pressed", String(button.dataset.quality === state.draft.quality));
  }
  for (const checkbox of $("issues").querySelectorAll("input")) {
    checkbox.checked = state.draft.reasons.includes(checkbox.value);
  }
  $("notes").value = state.draft.notes;
  $("certainty").value = state.draft.certainty;
  renderOffsets();
  window.egcReview?.renderAdmission?.(state, async () => {
    const id = state.current?.id;
    state.session = await request("/api/session?refresh=1");
    const item = state.session.items.find(item => item.id === id);
    if (item) { await select(item); }
  }, boundaries => { state.draft.boundaries = boundaries; marksChanged(); });
}

function toggleCategory(category) {
  if (state.draft.tags.includes(category)) {
    state.draft.tags = state.draft.tags.filter((tag) => tag !== category && !state.session.taxonomy[category].includes(tag));
    state.activeCategory = state.draft.tags.find((tag) => Object.keys(categoryNames).includes(tag)) || null;
  } else {
    state.draft.tags.push(category);
    state.activeCategory = category;
  }
  if (state.draft.certainty === "unsure") { state.draft.certainty = "tentative"; }
  changed();
  renderJudgement();
}

function toggleRole(role) {
  if (state.draft.tags.includes(role)) {
    state.draft.tags = state.draft.tags.filter((tag) => tag !== role);
  } else {
    state.draft.tags.push(role);
    if (!state.draft.tags.includes(state.activeCategory)) { state.draft.tags.push(state.activeCategory); }
  }
  changed();
  renderJudgement();
}

function audioContext() {
  if (!state.context) {
    state.context = new AudioContext();
    state.gain = state.context.createGain();
    state.gain.gain.value = $("volume").value / 100;
    state.gain.connect(state.context.destination);
  }
  return state.context;
}

async function loadBuffer(url, key = url) {
  if (state.buffers.has(key)) { return state.buffers.get(key); }
  const promise = (window.egcReview ? window.egcReview.audio(url) : fetch(url)).then(async (response) => {
    if (!response.ok) { throw new Error("Audio is unavailable. Prepare and refresh the library if it has changed."); }
    return audioContext().decodeAudioData(await response.arrayBuffer());
  });
  state.buffers.set(key, promise);
  promise.then((buffer) => {
    if (state.buffers.get(key) !== promise) { return; }
    state.bufferBytes.set(key, buffer.length * buffer.numberOfChannels * 4);
    let total = Array.from(state.bufferBytes.values()).reduce((sum, bytes) => sum + bytes, 0);
    for (const candidate of state.buffers.keys()) {
      if (state.buffers.size <= 16 && total <= 128 * 1024 * 1024) { break; }
      total -= state.bufferBytes.get(candidate) || 0;
      state.buffers.delete(candidate); state.bufferBytes.delete(candidate);
    }
  }, () => { if (state.buffers.get(key) === promise) { state.buffers.delete(key); state.bufferBytes.delete(key); } });
  return promise;
}

function stop(preserve = false) {
  state.playbackSerial++;
  cancelAnimationFrame(state.animation);
  const player = state.player;
  if (player) {
    state.seek = preserve ? playhead() : 0;
    player.source.onended = null;
    player.source.stop();
    state.player = null;
  } else if (!preserve) { state.seek = 0; }
  $("play").firstChild.textContent = "▶ Play ";
  drawAll();
}

function viewAudio(view = state.view) {
  const item = state.current;
  if (view === "primary") { return { buffer: state.primary, low: 0, high: item.duration }; }
  if (view === "marks") {
    return { buffer: state.original, low: (state.draft.boundaries.attackFrame ?? item.startFrame) / item.rate,
      high: Math.min((state.draft.boundaries.endFrame ?? item.endFrame) / item.rate,
        state.original?.duration ?? item.sourceDuration) };
  }
  if (view === "context") {
    return { buffer: state.original, low: Math.max(0, item.startSeconds - .15), high: Math.min(item.sourceDuration, item.endSeconds + .25) };
  }
  return { buffer: state.original, low: 0, high: item.sourceDuration };
}

async function play(view = state.view, bounds = null) {
  if (!state.current || !state.primary) { return; }
  const serial = state.serial;
  const playbackSerial = ++state.playbackSerial;
  const ctx = audioContext();
  await ctx.resume();
  if (serial !== state.serial || playbackSerial !== state.playbackSerial) { return; }
  const sameView = view === state.view;
  const previousSeek = sameView ? state.seek : 0;
  stop();
  state.view = view;
  const audio = viewAudio(view);
  const low = bounds ? bounds[0] : audio.low;
  const high = bounds ? bounds[1] : Math.min(audio.high, audio.buffer?.duration ?? audio.high);
  if (!audio.buffer || !Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high <= low) {
    renderViews();
    return status("Your end mark must be after your attack mark. Adjust or clear a mark before playing.", true);
  }
  const offset = Math.max(low, previousSeek > low && previousSeek < high ? previousSeek : low);
  if (!sameView) { state.centers.overview = offset; state.waveFocus.overview = offset; }
  const source = ctx.createBufferSource();
  source.buffer = audio.buffer;
  source.connect(state.gain);
  source.loop = $("loop").checked;
  source.loopStart = low;
  source.loopEnd = high;
  state.player = { source, offset, started: ctx.currentTime, low, high, bounds };
  source.onended = () => {
    if (state.player?.source === source) { state.player = null; state.seek = 0; $("play").firstChild.textContent = "▶ Play "; drawAll(); }
  };
  if (source.loop) { source.start(0, offset); } else { source.start(0, offset, high - offset); }
  $("play").firstChild.textContent = "Ⅱ Pause ";
  renderViews();
  animate();
}

function renderViews() {
  $("view-primary").classList.toggle("active", state.view === "primary");
  $("view-marks").classList.toggle("active", state.view === "marks");
  $("view-source").classList.toggle("active", state.view === "source");
  $("view-context").classList.toggle("active", state.view === "context");
  const marked = hasMarks();
  const audio = viewAudio("marks");
  const valid = !!state.original && audio.low >= 0 && audio.high > audio.low;
  $("view-marks").disabled = $("loop-join").disabled = !marked || !valid;
  $("play").disabled = state.view === "marks" && !valid;
  $("marked-range").classList.toggle("error", marked && !valid && !!state.original);
  $("marked-range").textContent = !marked ? "Mark an attack or end to audition your cut." : audio.high <= audio.low ?
    "End must follow attack. Adjust or clear a mark." :
    `Your cut: ${audio.low.toFixed(5)}–${audio.high.toFixed(5)} s · ${(audio.high - audio.low).toFixed(5)} s long` +
    (state.draft.boundaries.attackFrame === null ? " · start uses sample cut" : "") +
    (state.draft.boundaries.endFrame === null ? " · end uses sample cut" : "");
}

function hasMarks() {
  return state.draft?.boundaries.attackFrame != null || state.draft?.boundaries.endFrame != null;
}

function playMarked(join = false) {
  if (!hasMarks()) { return status("Mark an attack or end first.", true); }
  stop();
  state.view = "marks";
  const audio = viewAudio();
  state.seek = join ? audio.high - Math.min(.25, (audio.high - audio.low) / 2) : audio.low;
  if (join) { $("loop").checked = true; }
  state.centers.overview = state.waveFocus.overview = (audio.low + audio.high) / 2;
  renderViews(); drawAll();
  return play("marks");
}

function marksChanged() {
  const playing = !!state.player;
  changed(); stop();
  state.view = hasMarks() ? "marks" : "primary";
  const audio = viewAudio();
  state.centers.overview = state.waveFocus.overview = (audio.low + audio.high) / 2;
  renderOffsets(); renderViews(); drawAll();
  if (playing) { play(); }
}

function playhead() {
  if (!state.player) {
    const audio = viewAudio();
    return state.seek >= audio.low && state.seek < audio.high ? state.seek : audio.low;
  }
  const player = state.player;
  let at = player.offset + state.context.currentTime - player.started;
  if (player.source.loop && at >= player.high) { at = player.low + (at - player.low) % (player.high - player.low); }
  return Math.min(player.high, at);
}

function waveform(canvas, buffer, low, high, options = {}) {
  state.ranges[canvas.id] = [low, high];
  const width = Math.max(1, Math.floor(canvas.clientWidth));
  const height = canvas.clientHeight;
  const scale = window.devicePixelRatio || 1;
  if (canvas.width !== Math.floor(width * scale) || canvas.height !== Math.floor(height * scale)) {
    canvas.width = Math.floor(width * scale);
    canvas.height = Math.floor(height * scale);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const head = () => {
    if (options.head === undefined || high <= low) { return; }
    const x = (options.head - low) / (high - low) * width;
    ctx.strokeStyle = "#f4faf5"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height - 14); ctx.stroke();
  };
  const key = [low, high, width, height, scale, options.marker, options.reference,
    options.region?.join(","), options.transients?.join(",")].join(":");
  const cached = waveformCache.get(canvas);
  if (buffer && cached?.buffer === buffer && cached.key === key) {
    ctx.clearRect(0, 0, width, height); ctx.drawImage(cached.image, 0, 0, width, height); head(); return;
  }
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#080e09";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#273230";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath(); ctx.moveTo(width * i / 4, 0); ctx.lineTo(width * i / 4, height); ctx.stroke();
  }
  const zeroLine = () => {
    ctx.save(); ctx.strokeStyle = "#9ab19e"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, height / 2 + .5); ctx.lineTo(width, height / 2 + .5); ctx.stroke();
    ctx.fillStyle = "#b4c9b8"; ctx.font = "11px monospace"; ctx.fillText("0", 4, height / 2 - 5); ctx.restore();
  };
  if (!buffer || high <= low) { zeroLine(); return; }
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  let maximum = .05;
  const values = [];
  for (let x = 0; x < width; x++) {
    const rawFrom = Math.floor((low + (high - low) * x / width) * buffer.sampleRate);
    const rawTo = Math.max(rawFrom + 1, Math.floor((low + (high - low) * (x + 1) / width) * buffer.sampleRate));
    const from = Math.max(0, rawFrom);
    const to = Math.min(buffer.length, rawTo);
    let minimum = 0, peak = 0;
    for (const channel of channels) {
      for (let frame = from; frame < to; frame++) {
        minimum = Math.min(minimum, channel[frame]); peak = Math.max(peak, channel[frame]);
      }
    }
    maximum = Math.max(maximum, peak, -minimum);
    values.push([minimum, peak]);
  }
  ctx.strokeStyle = "#7dff72";
  const factor = (height / 2 - 15) / maximum;
  if ((high - low) * buffer.sampleRate <= width * 2) {
    // At close zoom, trace signed samples instead of bars extending to zero.
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, width, height - 14); ctx.clip();
    for (const [index, channel] of channels.entries()) {
      ctx.strokeStyle = index === 0 ? "#7dff72" : "#72dfff";
      ctx.beginPath();
      const from = Math.max(0, Math.floor(low * buffer.sampleRate));
      const to = Math.min(buffer.length - 1, Math.ceil(high * buffer.sampleRate));
      for (let frame = from; frame <= to; frame++) {
        const x = (frame / buffer.sampleRate - low) / (high - low) * width;
        const y = height / 2 - channel[frame] * factor;
        if (frame === from) { ctx.moveTo(x, y); } else { ctx.lineTo(x, y); }
      }
      ctx.stroke();
    }
    ctx.restore();
  } else {
    ctx.beginPath();
    for (let x = 0; x < width; x++) {
      ctx.moveTo(x + .5, height / 2 - values[x][1] * factor); ctx.lineTo(x + .5, height / 2 - values[x][0] * factor);
    }
    ctx.stroke();
  }
  zeroLine();
  const line = (seconds, colour, dash = []) => {
    const x = (seconds - low) / (high - low) * width;
    if (x < 0 || x > width) { return; }
    ctx.strokeStyle = colour; ctx.lineWidth = 1.5; ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height - 14); ctx.stroke(); ctx.setLineDash([]);
  };
  for (const marker of options.transients || []) { line(marker, "#8a9c8755", [2, 4]); }
  if (options.region) {
    const start = Math.max(0, (options.region[0] - low) / (high - low) * width);
    const end = Math.min(width, (options.region[1] - low) / (high - low) * width);
    ctx.fillStyle = "#ade7bb16";
    ctx.fillRect(start, 0, Math.max(0, end - start), height);
  }
  if (options.marker !== undefined) { line(options.marker, "#efbd73"); }
  if (options.reference !== undefined && options.reference !== null) { line(options.reference, "#bef2c8", [4, 3]); }
  ctx.font = "9px system-ui"; ctx.fillStyle = "#8b9d94"; ctx.textAlign = "left";
  const ticks = width < 220 ? 2 : 4;
  for (let i = 0; i <= ticks; i++) {
    const seconds = low + (high - low) * i / ticks;
    const precision = high - low < .01 ? 5 : high - low < 1 ? 3 : 2;
    const text = options.marker === undefined ? seconds.toFixed(precision) + "s" : ((seconds - options.marker) * 1000).toFixed(high - low < .01 ? 3 : 1) + "ms";
    ctx.textAlign = i === ticks ? "right" : i === 0 ? "left" : "center";
    ctx.fillText(text, width * i / ticks, height - 3);
  }
  const image = document.createElement("canvas");
  image.width = canvas.width; image.height = canvas.height;
  image.getContext("2d").drawImage(canvas, 0, 0);
  waveformCache.set(canvas, { buffer, key, image });
  head();
}

function attackCandidate() {
  return state.current.kind === "hit" || state.current.origin === "separated" ? state.current.startFrame : (state.current.transients[0] || 0);
}

function waveDuration(name) {
  return name === "overview" ? (viewAudio().buffer?.duration || state.current.duration) : state.current.sourceDuration;
}

function zoomControl(name) {
  return $(name === "overview" ? "overview-zoom" : "zoom");
}

function waveRange(name) {
  const duration = waveDuration(name);
  const value = zoomControl(name).value;
  if (name === "overview" && state.view === "marks" && value === "full") {
    const audio = viewAudio();
    if (audio.high > audio.low) { return [audio.low, audio.high]; }
  }
  const span = value === "full" ? duration : Math.min(duration, Number(value));
  const low = Math.max(0, Math.min(duration - span, state.centers[name] - span / 2));
  return [low, low + span];
}

function boundaryFrame(name) {
  return state.draft.boundaries[name === "attack" ? "attackFrame" : "endFrame"];
}

function panWave(name, center) {
  state.centers[name] = Math.max(0, Math.min(waveDuration(name), center));
  state.waveFocus[name] = state.centers[name];
  drawAll();
}

function changeZoom(control, anchor = null) {
  if (!state.current) { return; }
  for (const name of control.id === "zoom" ? ["attack", "tail"] : ["overview"]) {
    state.centers[name] = state.waveFocus[name];
    if (anchor?.name === name) {
      const span = control.value === "full" ? waveDuration(name) : Math.min(waveDuration(name), Number(control.value));
      state.centers[name] = anchor.seconds + (.5 - anchor.fraction) * span;
      state.waveFocus[name] = anchor.seconds;
    }
  }
  drawAll();
}

function renderWaveNavigation(name, range) {
  const duration = waveDuration(name);
  const slider = $(name + "-position");
  slider.value = (range[0] + range[1]) / 2 / duration * 1000;
  slider.disabled = (name === "overview" && state.view === "marks" && zoomControl(name).value === "full") || range[1] - range[0] >= duration;
  slider.setAttribute("aria-valuetext", ((range[0] + range[1]) / 2).toFixed(4) + " seconds into source");
  for (const button of document.querySelectorAll(`[data-pan="${name}"]`)) {
    button.disabled = slider.disabled || (Number(button.dataset.direction) < 0 ? range[0] <= 0 : range[1] >= duration);
  }
  if (name !== "overview") {
    const candidate = (name === "attack" ? attackCandidate() : state.current.endFrame) / state.current.rate;
    $(name + "-reference").disabled = boundaryFrame(name) === null;
    $(name + "-location").textContent = `Source ${range[0].toFixed(4)}–${range[1].toFixed(4)} s${candidate < range[0] || candidate > range[1] ? " · cut off-screen" : ""}`;
  }
}

function drawAll() {
  if (!state.current) { return; }
  const item = state.current;
  const audio = viewAudio();
  const overviewRange = waveRange("overview");
  waveform($("overview"), audio.buffer, ...overviewRange, {
    head: playhead(),
    transients: state.view === "primary" && item.kind === "hit" ? [] : item.transients.map((frame) => (frame - (state.view === "primary" ? item.startFrame : 0)) / item.rate),
    region: state.view === "marks" ? [audio.low, audio.high] :
      state.view !== "primary" && (item.kind === "hit" || item.origin === "separated") ? [item.startSeconds, item.endSeconds] : null,
  });
  const attack = attackCandidate() / item.rate;
  const end = item.endFrame / item.rate;
  const transients = item.transients.map((frame) => frame / item.rate);
  waveform($("attack"), state.original, ...waveRange("attack"),
    { marker: attack, reference: state.draft.boundaries.attackFrame === null ? null : state.draft.boundaries.attackFrame / item.rate, transients });
  waveform($("tail"), state.original, ...waveRange("tail"),
    { marker: end, reference: state.draft.boundaries.endFrame === null ? null : state.draft.boundaries.endFrame / item.rate, transients });
  for (const name of ["overview", "attack", "tail"]) { renderWaveNavigation(name, state.ranges[name]); }
  $("audio-time").textContent = state.view === "marks" ?
    `${Math.max(0, playhead() - audio.low).toFixed(2)} / ${Math.max(0, audio.high - audio.low).toFixed(2)} s` :
    `${playhead().toFixed(2)} / ${(audio.buffer?.duration || item.duration).toFixed(2)} s`;
}

function animate() {
  drawAll();
  if (state.player) { state.animation = requestAnimationFrame(animate); }
}

function renderOffsets() {
  if (!state.current) { return; }
  for (const [name, candidate] of [["attack", attackCandidate()], ["end", state.current.endFrame]]) {
    const frame = state.draft.boundaries[name + "Frame"];
    const output = $(name + "-offset");
    if (frame === null) { output.textContent = "Unmarked"; }
    else {
      const delta = (frame - candidate) * 1000 / state.current.rate;
      output.textContent = `Ref ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} ms · frame ${frame}`;
    }
  }
}

function renderSourceOrigin(item) {
  let label, detail;
  if (item.kind === "hit") {
    label = "Extracted hit";
    detail = `Source ${item.startSeconds.toFixed(3)}–${item.endSeconds.toFixed(3)} s of ${item.sourceDuration.toFixed(3)} s original file`;
  } else if (item.origin === "separated") {
    label = "Region separated from original";
    detail = `Source ${item.startSeconds.toFixed(3)}–${item.endSeconds.toFixed(3)} s of ${item.sourceDuration.toFixed(3)} s original file`;
  } else {
    label = "Original file in full";
    detail = item.archived ? "Reviewed original · this file has since been separated into regions" :
      `Full ${item.sourceDuration.toFixed(3)} s file`;
  }
  $("source-origin-label").textContent = label;
  $("source-origin-detail").textContent = detail;
}

async function select(item, autoplay = false) {
  if (!item || state.saving) { return; }
  rememberDraft();
  stop();
  const serial = ++state.serial;
  state.current = item;
  state.draft = JSON.parse(JSON.stringify(state.drafts.get(item.id) || item.review || {
    tags: [...(item.currentTags || item.prediction || [])].filter(tag => tag !== "unclassified"), certainty: "clear", quality: null, reasons: [], notes: "", boundaries: {},
  }));
  state.draft.boundaries = {
    attackFrame: state.draft.boundaries?.attackFrame ?? null,
    endFrame: state.draft.boundaries?.endFrame ?? null,
  };
  state.draft.reasons = state.draft.reasons || [];
  state.draft.notes = state.draft.notes || "";
  state.centers = { overview: 0, attack: (state.draft.boundaries.attackFrame ?? attackCandidate()) / item.rate,
    tail: (state.draft.boundaries.endFrame ?? item.endFrame) / item.rate };
  state.waveFocus = { ...state.centers };
  state.activeCategory = state.draft.tags.find((tag) => Object.keys(categoryNames).includes(tag)) || null;
  state.dirty = state.drafts.has(item.id);
  state.view = hasMarks() ? "marks" : "primary"; state.primary = null; state.original = null;
  $("item-title").textContent = itemLabel(item);
  $("item-kind").textContent = item.kind === "hit" ? "EXTRACTED HIT" : item.archived ? "REVIEWED SOURCE · NOW SPLIT" : item.origin === "separated" ? "SEPARATED SAMPLE" : "SAMPLE";
  $("item-meta").textContent = `${item.duration.toFixed(3)} seconds · ${item.channels === 1 ? "mono" : "stereo"} · ${(item.rate / 1000).toFixed(1)} kHz`;
  $("details").textContent = `${item.sourcePath || item.filename || ""} · Current category: ${(item.currentTags || item.prediction || []).map(title).join(" · ") || "Unassigned"}`;
  if (item.review?.tags?.length) { $("details").textContent += ` · Saved correction: ${item.review.tags.map(title).join(" · ")}`; }
  if (item.roleEvidence?.mode === "alternatives") {
    $("details").textContent += ` · Suggested alternatives: ${item.roleEvidence.candidates.map(title).join(" or ")}`;
  }
  $("item-review-reasons").textContent = itemReasons(item).map(reason => reason.replaceAll("-", " ")).join(" · ");
  $("item-review-reasons").hidden = !itemReasons(item).length;
  renderSourceOrigin(item);
  $("view-primary").firstChild.textContent = item.kind === "hit" ? "Hit " : "Sample ";
  $("view-source").hidden = item.kind !== "hit" && item.origin !== "separated";
  $("view-context").hidden = item.kind !== "hit" && item.origin !== "separated";
  $("workspace").hidden = false;
  $("loading").hidden = true;
  renderQueue(); renderJudgement(); renderViews(); drawAll(); saveLocal();
  status("Loading audio…");
  try {
    const [primary, original] = await Promise.all([
      loadBuffer("/api/audio/" + item.id, item.mediaKey || item.id),
      item.kind === "hit" || item.origin === "separated" ? loadBuffer("/api/source/" + item.id, item.sourceKey || "source-" + item.id) : loadBuffer("/api/audio/" + item.id, item.mediaKey || item.id),
    ]);
    if (serial !== state.serial) { return; }
    state.primary = primary; state.original = original;
    renderViews(); drawAll();
    status(state.dirty ? "Unsaved judgement · Enter saves and moves on." : state.session.publicationSupported ? "Check the category and cuts, save, then approve the corrected sound below." : "Space to listen. Save your corrected category and cuts when ready.");
    if (autoplay) { await play(); }
  } catch (error) {
    if (serial === state.serial) { status(error.message, true); }
  }
}

function navigate(direction) {
  const items = queueItems();
  if (!items.length) { return; }
  const index = items.findIndex((item) => item.id === state.current?.id);
  if (index < 0) { select(direction > 0 ? items[0] : items.at(-1)); return; }
  select(items[(index + direction + items.length) % items.length]);
}

function pickAfter(previousId, previousQueue) {
  const candidates = queueItems();
  if (state.restartQueueAfterDraft) { state.restartQueueAfterDraft = false; return candidates[0]; }
  const remaining = new Map(candidates.map(item => [item.id,item]));
  const index = previousQueue.indexOf(previousId);
  return previousQueue.slice(index+1).map(id => remaining.get(id)).find(Boolean) || candidates.find(item => item.id !== previousId) || candidates[0];
}

async function save(unsure = false) {
  if (!state.current || state.saving) { return; }
  const id = state.current.id, previousQueue = queueItems().map(item => item.id);
  if (unsure) {
    state.draft.certainty = "unsure";
    state.draft.tags = [];
    if ((state.mode === "hit" || state.current.origin === "separated") && !state.draft.quality) { state.draft.quality = "unsure"; }
  }
  if (state.mode === "sample" && !state.draft.tags.length && state.draft.certainty !== "unsure") {
    return status("Choose a category, or use Unsure & next.", true);
  }
  if ((state.mode === "hit" || state.current.origin === "separated") && !state.draft.quality) {
    return status("Assess the extraction or grouping first, or choose Unsure.", true);
  }
  if ($("autoplay").checked) { audioContext().resume(); }
  rememberDraft();
  state.saving = true; $("save").disabled = true; $("unsure").disabled = true;
  try {
    await request("/api/review/" + id, state.draft);
    state.drafts.delete(id);
    state.dirty = false;
    state.session = await request("/api/session");
    state.saving = false;
    const next = pickAfter(id, previousQueue);
    if (next) { await select(next, $("autoplay").checked); }
    else {
      state.current = state.session.items.find((item) => item.id === id);
      stop(); renderQueue();
      status("Queue complete. Switch collections, or use Needs another listen for a second pass.");
    }
    saveLocal();
  } catch (error) {
    status("Could not save: " + error.message + ". Your choices are still here.", true);
  } finally {
    state.saving = false; $("save").disabled = false; $("unsure").disabled = false;
  }
}

async function switchMode(mode) {
  rememberDraft();
  state.mode = mode;
  $("filter").value = state.filter;
  const next = queueItems()[0];
  if (next) { await select(next); }
  else { emptyQueue(); }
}

function emptyQueue() {
  stop(); state.serial++; state.current = null; state.primary = null; state.original = null;
  $("workspace").hidden = true; $("loading").hidden = false;
  $("loading").textContent = "No sounds match these filters. Change the review status, folder or category, or clear the search.";
  renderQueue();
}

async function refresh() {
  try {
    rememberDraft();
    state.buffers.clear(); state.bufferBytes.clear();
    state.session = await request("/api/session?refresh=1");
    const item = queueItems().find((item) => item.id === state.current?.id) || queueItems()[0];
    if (item) { await select(item); } else { emptyQueue(); }
    renderQueue();
  } catch (error) { status(error.message, true); }
}

$("samples-tab").addEventListener("click", () => switchMode("sample"));
$("hits-tab").addEventListener("click", () => switchMode("hit"));
$("refresh").addEventListener("click", refresh);
function applyQueueFilters() {
  rememberDraft();
  const candidates = queueItems();
  renderQueue();
  if (!candidates.some(item => item.id === state.current?.id)) {
    if (candidates[0]) { void select(candidates[0]); }
    else { emptyQueue(); }
  }
  saveLocal();
}
$("filter").addEventListener("change", () => { state.filter = $("filter").value; applyQueueFilters(); });
for (const [id,key] of [["category-filter","category"],["folder-filter","folder"],["reason-filter","reason"],["queue-sort","sort"]]) {
  $(id).addEventListener("change", () => { state[key] = $(id).value; applyQueueFilters(); });
}
$("queue-search").addEventListener("input", () => { state.search = $("queue-search").value; applyQueueFilters(); });
$("clear-queue-filters").addEventListener("click", () => {
  state.search = state.category = state.folder = state.reason = ""; applyQueueFilters();
});
$("play").addEventListener("click", () => state.player ? stop(true) : play());
$("previous").addEventListener("click", () => navigate(-1));
$("next").addEventListener("click", () => navigate(1));
$("view-primary").addEventListener("click", () => play("primary"));
$("view-marks").addEventListener("click", () => playMarked());
$("loop-join").addEventListener("click", () => playMarked(true));
$("view-source").addEventListener("click", () => play("source"));
$("view-context").addEventListener("click", () => play("context"));
$("volume").addEventListener("input", () => { if (state.gain) { state.gain.gain.setTargetAtTime($("volume").value / 100, state.context.currentTime, .01); } });
$("loop").addEventListener("change", () => {
  if (state.player) {
    const bounds = state.player.bounds;
    stop(true); play(state.view, bounds);
  }
});
for (const name of ["overview", "attack", "tail"]) {
  const canvas = $(name);
  let drag = null, suppressClick = false, lastWheel = -Infinity;
  canvas.addEventListener("pointerdown", (event) => {
    if (!state.primary || event.button !== 0) { return; }
    canvas.focus({ preventScroll: true });
    const range = state.ranges[name];
    drag = { x: event.clientX, center: (range[0] + range[1]) / 2, span: range[1] - range[0], moved: false, serial: state.serial };
    suppressClick = false;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!drag || drag.serial !== state.serial) { return; }
    const delta = event.clientX - drag.x;
    drag.moved = drag.moved || Math.abs(delta) > 4;
    if (drag.moved) {
      canvas.classList.add("panning");
      panWave(name, drag.center - delta / canvas.getBoundingClientRect().width * drag.span);
    }
  });
  canvas.addEventListener("pointerup", () => {
    suppressClick = !!drag?.moved;
    drag = null; canvas.classList.remove("panning");
  });
  canvas.addEventListener("pointercancel", () => {
    drag = null; suppressClick = true; canvas.classList.remove("panning");
  });
  canvas.addEventListener("click", (event) => {
    if (suppressClick) { suppressClick = false; return; }
    if (!state.primary) { return; }
    canvas.focus({ preventScroll: true });
    const bounds = canvas.getBoundingClientRect();
    const range = state.ranges[name];
    const seconds = range[0] + (event.clientX - bounds.left) / bounds.width * (range[1] - range[0]);
    state.waveFocus[name] = seconds;
    if (name === "overview") {
      stop(); state.seek = seconds; play(state.view); return;
    }
    if (!state.original) { return; }
    state.draft.boundaries[name === "attack" ? "attackFrame" : "endFrame"] = Math.max(0, Math.min(state.current.sourceFrames, Math.round(seconds * state.current.rate)));
    marksChanged();
  });
  canvas.addEventListener("wheel", (event) => {
    if (!state.primary || event.ctrlKey || event.metaKey) { return; }
    event.preventDefault();
    if (event.timeStamp - lastWheel < 120) { return; }
    lastWheel = event.timeStamp;
    const range = state.ranges[name];
    if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      panWave(name, (range[0] + range[1]) / 2 + Math.sign(event.deltaX || event.deltaY) * (range[1] - range[0]) / 2);
      return;
    }
    if (!event.deltaY) { return; }
    const control = zoomControl(name);
    const steps = zoomSteps.filter((step) => step === "full" || step < waveDuration(name));
    let index = steps.findIndex((step) => String(step) === control.value);
    if (index < 0) { index = steps.length - 1; }
    const next = Math.max(0, Math.min(steps.length - 1, index + Math.sign(event.deltaY)));
    const rect = canvas.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    control.value = String(steps[next]);
    changeZoom(control, { name, fraction, seconds: range[0] + fraction * (range[1] - range[0]) });
  }, { passive: false });
  $(name + "-position").addEventListener("input", () => {
    if (state.current) { panWave(name, Number($(name + "-position").value) / 1000 * waveDuration(name)); }
  });
}
for (const [id, initial] of [["zoom", "0.05"], ["overview-zoom", "full"]]) {
  const control = $(id);
  for (const value of zoomSteps) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value === "full" ? (id === "zoom" ? "Full source" : "Full audio") : value < 1 ? value * 1000 + " ms" : value + " s";
    control.append(option);
  }
  control.value = initial;
  control.addEventListener("change", () => changeZoom(control));
}
for (const button of document.querySelectorAll("[data-pan]")) {
  button.addEventListener("click", () => {
    if (!state.current) { return; }
    const name = button.dataset.pan;
    const range = state.ranges[name];
    panWave(name, (range[0] + range[1]) / 2 + Number(button.dataset.direction) * (range[1] - range[0]) / 2);
  });
}
for (const button of document.querySelectorAll("[data-center]")) {
  button.addEventListener("click", () => {
    if (!state.current) { return; }
    const name = button.dataset.center;
    const frame = button.dataset.target === "reference" ? boundaryFrame(name) : name === "attack" ? attackCandidate() : state.current.endFrame;
    if (frame !== null) { panWave(name, frame / state.current.rate); }
  });
}
for (const name of ["attack", "end"]) {
  const prefix = name === "end" ? "tail" : "attack";
  $(prefix + "-play").addEventListener("click", () => {
    if (!state.original) { return; }
    const at = Math.max(0, Math.min(state.current.sourceDuration, state.waveFocus[prefix]));
    state.seek = 0;
    play("source", [Math.max(0, at - .12), Math.min(state.current.sourceDuration, at + .18)]);
  });
  $(prefix + "-clear").addEventListener("click", () => { state.draft.boundaries[name + "Frame"] = null; marksChanged(); });
}
$("certainty").addEventListener("change", () => { state.draft.certainty = $("certainty").value; changed(); });
$("notes").addEventListener("input", () => { state.draft.notes = $("notes").value; changed(); });
for (const button of document.querySelectorAll("[data-quality]")) {
  button.addEventListener("click", () => { state.draft.quality = button.dataset.quality; changed(); renderJudgement(); });
}
$("issues").addEventListener("change", () => { state.draft.reasons = Array.from($("issues").querySelectorAll("input:checked"), (input) => input.value); changed(); });
$("save").addEventListener("click", () => save());
$("unsure").addEventListener("click", () => save(true));
$("undo").addEventListener("click", async () => {
  if (state.saving) { return; }
  try {
    rememberDraft();
    const result = await request("/api/undo", {});
    state.session = await request("/api/session");
    const item = state.session.items.find((candidate) => candidate.id === result.id);
    if (item) {
      state.drafts.delete(item.id); state.dirty = false; state.mode = item.kind;
      if (state.filter === "unreviewed" && item.review) { $("filter").value = state.filter = "all"; }
      await select(item); status("Previous saved judgement restored.");
    }
    renderQueue();
  } catch (error) { status(error.message, true); }
});
$("export").addEventListener("click", async () => {
  try {
    const value = await request("/api/export");
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "egc1-reviews.json"; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status("Exported saved judgements. Unsaved drafts are not included.");
  } catch (error) { status(error.message, true); }
});
document.addEventListener("keydown", (event) => {
  if (!state.current || event.altKey || event.metaKey || (event.ctrlKey && event.key !== "Enter")) { return; }
  if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) {
    if (event.ctrlKey && event.key === "Enter") { event.preventDefault(); save(); }
    return;
  }
  const key = event.key.toLowerCase();
  if ([" ", "arrowleft", "arrowright", "enter", "s", "z", "a", "b", "c", "m", "j", "g", "x", ...roleKeys, "1", "2", "3", "4", "5"].includes(key)) { event.preventDefault(); }
  if (key === " ") { state.player ? stop(true) : play(); }
  else if (key === "arrowleft") { navigate(-1); }
  else if (key === "arrowright") { navigate(1); }
  else if (key === "enter") { save(); }
  else if (key === "s") { save(true); }
  else if (key === "z") { $("undo").click(); }
  else if (/^[1-5]$/.test(key)) { toggleCategory(Object.keys(categoryNames)[Number(key) - 1]); }
  else if (roleKeys.includes(key) && state.session.taxonomy[state.activeCategory]?.[roleKeys.indexOf(key)]) { toggleRole(state.session.taxonomy[state.activeCategory][roleKeys.indexOf(key)]); }
  else if (key === "b") { state.seek = 0; play("primary"); }
  else if (key === "a") { state.seek = 0; play("source"); }
  else if (key === "c") { state.seek = 0; play("context"); }
  else if (key === "m") { playMarked(); }
  else if (key === "j") { playMarked(true); }
  else if (["g", "x"].includes(key)) {
    state.draft.quality = key === "g" ? "keep" : "reject"; changed(); renderJudgement();
  }
});
window.addEventListener("resize", drawAll);
window.addEventListener("beforeunload", rememberDraft);

async function start() {
  try {
    state.session = await request("/api/session");
    if (state.session.publicationSupported) { state.filter = "pending"; }
    else if (state.session.items.some(item => item.instrument?.needsAttention)) { state.filter = "instrument"; }
    try {
      let saved = JSON.parse(localStorage.getItem("egc1-review:" + state.session.fingerprint) || localStorage.getItem("toy-audition:" + state.session.fingerprint) || "null");
      if (!saved) {
        const ids = new Set(state.session.items.map((item) => item.id));
        const previous = Object.keys(localStorage).filter((key) => (key.startsWith("egc1-review:") || key.startsWith("toy-audition:"))).map((key) => {
          try { return JSON.parse(localStorage.getItem(key)); } catch (_) { return null; }
        }).filter((value) => value && (ids.has(value.current) || value.drafts?.some(([id]) => ids.has(id))));
        previous.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
        saved = previous[0];
      }
      if (saved) {
        state.mode = saved.mode === "hit" ? "hit" : "sample";
        const ids = new Set(state.session.items.map((item) => item.id));
        state.drafts = new Map((saved.drafts || []).filter(([id]) => ids.has(id)));
        // Keep unfinished work when the catalogue changes; organise fresh
        // sessions by source rather than the earlier blind listening order.
        if (saved.queuePolicy === state.session.queuePolicy && saved.organisation) {
          const organisation = saved.organisation;
          for (const key of ["search","category","folder","reason"]) { if (typeof organisation[key] === "string") { state[key] = organisation[key]; } }
          if (["source","category","duration","longest"].includes(organisation.sort)) { state.sort = organisation.sort; }
          if ([...$("filter").options].some(option => option.value === organisation.filter) &&
              (state.session.publicationSupported || !["pending","accepted","excluded"].includes(organisation.filter))) { state.filter = organisation.filter; }
        }
        state.resume = saved.queuePolicy === state.session.queuePolicy || state.drafts.has(saved.current) ? saved.current : null;
        state.restartQueueAfterDraft = saved.queuePolicy !== state.session.queuePolicy && state.drafts.has(saved.current);
      }
    } catch (_) { /* Browser storage is optional. */ }
    if (["instrument", "pending"].includes(state.filter) && !queueItems().length) {
      state.mode = state.mode === "sample" ? "hit" : "sample";
    }
    renderQueue();
    const draftItem = allItems().find((candidate) => candidate.id === state.resume && state.drafts.has(candidate.id));
    if (draftItem?.review) { $("filter").value = state.filter = "all"; }
    const item = draftItem || queueItems().find((candidate) => candidate.id === state.resume) || queueItems()[0];
    if (item) { await select(item); }
    else { emptyQueue(); }
  } catch (error) { $("loading").textContent = "Could not open the library: " + error.message; }
}

if (!window.egcReview) { start(); }

$("resolve-instrument").addEventListener("click", async () => {
  if (!state.current?.instrument?.needsAttention) { return; }
  try {
    const id = state.current.id;
    await request("/api/resolve-instrument/" + id, {groups: state.current.instrument.groups});
    state.session = await request("/api/session");
    state.current = state.session.items.find(item => item.id === id);
    renderQueue(); renderJudgement();
    status("Instrument flag resolved. Your listening judgement is unchanged.");
  } catch (error) { status(error.message, true); }
});
