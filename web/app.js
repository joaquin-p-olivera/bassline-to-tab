// Main thread: UI, audio decoding (Web Audio API), song history and talking
// to the worker. The heavy lifting (Demucs, Basic Pitch) runs in worker.js.

import { ARCHIVE_EXTENSION, exportSongs, importSongs } from "./archive.js";
import { encodeOpus, isOpusBlob, OPUS_SAMPLE_RATE, opusSupported } from "./opus.js";
import { deleteSong, getSong, listSongs, putSongs, saveSong, songId, storageInfo } from "./storage.js";
import { TabView } from "./tab-view.js";

const SEPARATION_SAMPLE_RATE = 44100;
/// Bars per line in the downloadable .txt tab.
const TEXT_TAB_BARS_PER_LINE = 4;
/// localStorage key for the "save the separated tracks compressed" choice.
const COMPRESS_BASS_KEY = "bassline-to-tab.compressBass";
/// Where each instrument's separated stem, last result and options live in a
/// song record. The bass keeps the field names from before guitar existed.
const SONG_FIELDS = {
  bass: { stem: "bassWav", result: "lastResult", options: "lastOptions" },
  guitar: { stem: "guitarWav", result: "guitarResult", options: "guitarOptions" },
};
const INSTRUMENTS = Object.keys(SONG_FIELDS);
/// Demucs models: the 4-stem one has no guitar.
const BASS_MODEL = "htdemucs";
const GUITAR_MODEL = "htdemucs_6s";

const $ = (id) => document.getElementById(id);

const form = $("form");
const fileInput = $("audio");
const submitButton = $("submit");
const player = $("player");
const tabView = new TabView($("tab-view"));
// The tab scrolls the line being played to just below the sticky player.
new ResizeObserver(([entry]) =>
  $("tab-view").style.setProperty("--sticky-top", `${entry.target.offsetHeight}px`),
).observe($("player-box"));

/// The song being worked on: a history record (see storage.js).
let currentSong = null;
/// The transcriptions of the current song, by instrument.
let currentResults = {};
let currentInstrument = "bass";
let currentResult = null;
let fingeringStyle = "open-position";
let playerUrls = { bass: null, guitar: null, mix: null };
let currentSource = "mix";

// ─── Worker ─────────────────────────────────────────────────────────────────

const pending = new Map();
let nextRequestId = 1;
let worker = null;

function rejectPending(message) {
  for (const request of pending.values()) request.reject(new Error(message));
  pending.clear();
}

/// (Re)creates the worker. After a Rust panic or a lost GPU device the
/// WebAssembly instance is unusable, so a fresh worker lets the user retry
/// without reloading the page.
function startWorker() {
  worker?.terminate();
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    if (data.type === "progress") {
      request.onProgress?.(data);
      return;
    }
    pending.delete(data.id);
    if (data.type === "error") request.reject(new Error(data.message));
    else request.resolve(data);
  };
  worker.onerror = (event) => {
    console.error("Worker crashed:", event.message);
    rejectPending(event.message || "The worker crashed");
    startWorker();
  };
}

startWorker();

function callWorker(type, payload = {}, transfer = [], onProgress = null) {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, type, ...payload }, transfer);
  });
}

// ─── UI helpers ─────────────────────────────────────────────────────────────

/// Uses both Tailwind's class and the native attribute, so visibility works
/// even if the Tailwind CDN fails to load.
function show(element, visible) {
  element.classList.toggle("hidden", !visible);
  element.hidden = !visible;
}

for (const element of document.querySelectorAll(".hidden")) element.hidden = true;

function setStatus(text, { busy = true, detail = "", error = "" } = {}) {
  show($("status"), true);
  $("status-text").textContent = text;
  $("progress").textContent = detail;
  show($("spinner"), busy);
  const errorBox = $("error");
  errorBox.textContent = error;
  show(errorBox, error !== "");
}

function setProgress(fraction) {
  show($("progress-bar"), fraction !== null);
  if (fraction !== null) $("progress-fill").style.width = `${Math.round(fraction * 100)}%`;
}

function formatSeconds(seconds) {
  return seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

function formatDuration(seconds) {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function describeProgress({ stage, done, total }) {
  switch (stage) {
    case "download":
      return `Downloading the Demucs model: ${(done / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`;
    case "separate":
      return `Separating: chunk ${done} of ${total}`;
    case "transcribe":
      return `Detecting notes: window ${done} of ${total}`;
    default:
      return "";
  }
}

function tuningValue(instrument) {
  const [select, custom] = instrument === "guitar" ? ["guitar-tuning", "guitar-tuning-custom"] : ["tuning", "tuning-custom"];
  const selected = $(select).value;
  return selected === "custom" ? $(custom).value.trim() : selected;
}

/// "bass", "guitar" or "both", as chosen in the form.
function instrumentChoice() {
  return form.querySelector('input[name="instrument"]:checked')?.value ?? "bass";
}

function selectedInstruments() {
  const choice = instrumentChoice();
  return choice === "both" ? [...INSTRUMENTS] : [choice];
}

function setInstrumentChoice(choice) {
  const input = form.querySelector(`input[name="instrument"][value="${choice}"]`);
  if (input) input.checked = true;
  showTuningFields();
}

function showTuningFields() {
  const instruments = selectedInstruments();
  show($("bass-tuning-field"), instruments.includes("bass"));
  show($("guitar-tuning-field"), instruments.includes("guitar"));
}

function readOptions(instrument) {
  const bpm = parseFloat($("bpm").value);
  return {
    instrument,
    tuning: tuningValue(instrument),
    frets: parseInt($("frets").value, 10) || 24,
    bpm: Number.isFinite(bpm) ? bpm : null,
    onsetThreshold: parseFloat($("onset-threshold").value),
    minNoteMs: parseFloat($("min-note").value) || 80,
    barsPerLine: TEXT_TAB_BARS_PER_LINE,
  };
}

function download(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function baseName(name) {
  return name.replace(/\.[^.]+$/, "") || "bassline";
}

// ─── Audio ──────────────────────────────────────────────────────────────────

async function decodeBlob(blob, sampleRate) {
  const bytes = await blob.arrayBuffer();
  const context = new OfflineAudioContext(2, 1, sampleRate);
  const buffer = await context.decodeAudioData(bytes);
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left.slice();
  return { left, right, sampleRate: buffer.sampleRate, duration: buffer.duration };
}

/// Downmixes stereo to mono and resamples it with the browser's resampler.
async function toMono(left, right, fromRate, toRate) {
  const length = Math.ceil((left.length * toRate) / fromRate);
  const context = new OfflineAudioContext(1, length, toRate);
  const buffer = context.createBuffer(2, left.length, fromRate);
  buffer.copyToChannel(left, 0);
  buffer.copyToChannel(right, 1);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  const rendered = await context.startRendering();
  return rendered.getChannelData(0);
}

/// 16-bit mono WAV: the lossless way to store the bass stem.
function monoWavBlob(left, right, sampleRate) {
  const frames = left.length;
  const view = new DataView(new ArrayBuffer(44 + frames * 2));
  const writeString = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  writeString(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    const sample = Math.max(-1, Math.min(1, (left[i] + right[i]) / 2));
    view.setInt16(44 + i * 2, sample * 0x7fff, true);
  }
  return new Blob([view], { type: "audio/wav" });
}

/// Mono Ogg Opus of the bass stem, about a fifth of the WAV. It is decoded
/// back once before being kept, so a browser that encodes but cannot read it
/// falls back to WAV instead of losing the bass.
async function opusBlob(left, right, sampleRate) {
  const mono = await toMono(left, right, sampleRate, OPUS_SAMPLE_RATE);
  const blob = await encodeOpus(mono, sampleRate);
  const decoded = await decodeBlob(blob, sampleRate);
  if (Math.abs(decoded.duration - left.length / sampleRate) > 0.1) {
    throw new Error(`The compressed bass lasts ${decoded.duration.toFixed(2)} s instead of ${(left.length / sampleRate).toFixed(2)} s`);
  }
  return blob;
}

/// The bass stem as stored in the history: Opus if the user chose it and it
/// works here, WAV otherwise.
async function bassBlob(left, right, sampleRate) {
  if (compressBass()) {
    try {
      return await opusBlob(left, right, sampleRate);
    } catch (error) {
      console.warn("Could not compress the bass, saving it as WAV", error);
    }
  }
  return monoWavBlob(left, right, sampleRate);
}

function compressBass() {
  return $("compress-bass").checked && !$("compress-bass").disabled;
}

async function hasWebGpu() {
  try {
    return Boolean(navigator.gpu && (await navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

// ─── Player & tab ───────────────────────────────────────────────────────────

function setPlayerSources(song) {
  for (const url of Object.values(playerUrls)) if (url) URL.revokeObjectURL(url);
  playerUrls = { mix: URL.createObjectURL(song.file) };
  for (const instrument of INSTRUMENTS) {
    const stem = song[SONG_FIELDS[instrument].stem];
    playerUrls[instrument] = stem ? URL.createObjectURL(stem) : null;
  }
  for (const button of document.querySelectorAll(".source-button")) {
    button.disabled = !playerUrls[button.dataset.source];
    button.classList.toggle("opacity-40", button.disabled);
    // Without a guitar stem the button only adds noise.
    if (button.dataset.source === "guitar") show(button, !button.disabled);
  }
  selectSource(playerUrls[currentInstrument] ? currentInstrument : "mix");
}

function selectSource(source) {
  const url = playerUrls[source];
  if (!url) return;
  currentSource = source;
  const resumeAt = player.currentTime;
  const wasPlaying = !player.paused;
  if (player.src !== url) {
    player.src = url;
    player.addEventListener(
      "loadedmetadata",
      () => {
        player.currentTime = resumeAt;
        if (wasPlaying) player.play();
      },
      { once: true },
    );
  }
  for (const button of document.querySelectorAll(".source-button")) {
    const active = button.dataset.source === source;
    button.classList.toggle("bg-amber-600", active);
    button.classList.toggle("text-white", active);
  }
}

function followPlayback() {
  tabView.setTime(player.currentTime, true);
  if (!player.paused) requestAnimationFrame(followPlayback);
}

tabView.onSeek = (seconds) => {
  player.currentTime = seconds;
  tabView.setTime(seconds);
};

player.addEventListener("play", () => requestAnimationFrame(followPlayback));
player.addEventListener("seeked", () => tabView.setTime(player.currentTime));
document.querySelectorAll(".source-button").forEach((button) =>
  button.addEventListener("click", () => selectSource(button.dataset.source)),
);

function renderSummary(result) {
  const tuning =
    result.tuningCents === null
      ? "unknown"
      : `A4 = ${result.referenceA4Hz.toFixed(1)} Hz (${result.tuningCents >= 0 ? "+" : ""}${result.tuningCents.toFixed(0)} cents)`;
  const items = [
    ["Tempo", `${result.bpm.toFixed(1)} BPM`],
    ["Notes", String(result.notes.length)],
    [currentInstrument === "guitar" ? "Guitar tuning" : "Bass tuning", result.tuning],
    ["Recording tuning", tuning],
  ];
  $("summary").replaceChildren(
    ...items.map(([label, value]) => {
      const wrapper = document.createElement("div");
      const term = document.createElement("dt");
      term.className = "text-stone-500";
      term.textContent = label;
      const definition = document.createElement("dd");
      definition.className = "font-medium";
      definition.textContent = value;
      wrapper.append(term, definition);
      return wrapper;
    }),
  );
  const warnings = $("warnings");
  warnings.replaceChildren(
    ...result.warnings.map((text) => {
      const item = document.createElement("li");
      item.textContent = text;
      return item;
    }),
  );
  show(warnings, result.warnings.length > 0);
}

/// The tab in the selected fingering style. Songs saved before styles existed
/// only have one tab (open position) at the top level.
function currentFingering() {
  const fingerings = currentResult.fingerings ?? [
    { style: "open-position", tab: currentResult.tab, events: currentResult.events },
  ];
  return fingerings.find((f) => f.style === fingeringStyle) ?? fingerings[0];
}

function renderFingering() {
  const available = new Set((currentResult.fingerings ?? [{ style: "open-position" }]).map((f) => f.style));
  const shown = currentFingering().style;
  for (const button of document.querySelectorAll(".fingering-button")) {
    const style = button.dataset.fingering;
    button.disabled = !available.has(style);
    button.title = button.disabled ? "Transcribe this song again to get this fingering" : button.dataset.hint;
    button.classList.toggle("opacity-40", button.disabled);
    button.classList.toggle("bg-amber-600", style === shown);
    button.classList.toggle("text-white", style === shown);
  }
  tabView.setTranscription({ ...currentResult, ...currentFingering() });
  tabView.setTime(player.currentTime || 0);
}

document.querySelectorAll(".fingering-button").forEach((button) => {
  button.dataset.hint = button.title;
  button.addEventListener("click", () => {
    fingeringStyle = button.dataset.fingering;
    if (currentResult) renderFingering();
  });
});

/// Shows the song's transcriptions, starting with `preferred` if it has one.
function showResult(song, timings = [], preferred = currentInstrument) {
  currentResults = {};
  for (const instrument of INSTRUMENTS) {
    const result = song[SONG_FIELDS[instrument].result];
    if (result) currentResults[instrument] = result;
  }
  const available = Object.keys(currentResults);
  if (!available.length) {
    show($("result"), false);
    return;
  }
  currentInstrument = available.includes(preferred) ? preferred : available[0];
  show($("result"), true);
  setPlayerSources(song);
  renderInstrument();
  $("timings").textContent = timings.map(([label, value]) => `${label}: ${value}`).join(" · ");
}

function renderInstrument() {
  currentResult = currentResults[currentInstrument];
  show($("instrument-toggle"), Object.keys(currentResults).length > 1);
  for (const button of document.querySelectorAll(".instrument-button")) {
    const active = button.dataset.instrument === currentInstrument;
    button.disabled = !currentResults[button.dataset.instrument];
    button.classList.toggle("bg-amber-600", active);
    button.classList.toggle("text-white", active);
  }
  renderSummary(currentResult);
  renderFingering();
}

document.querySelectorAll(".instrument-button").forEach((button) =>
  button.addEventListener("click", () => {
    const instrument = button.dataset.instrument;
    if (!currentResults[instrument] || instrument === currentInstrument) return;
    currentInstrument = instrument;
    // Listening to one instrument alone, follow the switch to the other.
    if (currentSource !== "mix" && playerUrls[instrument]) selectSource(instrument);
    renderInstrument();
  }),
);

// ─── History ────────────────────────────────────────────────────────────────

function selectSong(song) {
  currentSong = song;
  fileInput.value = "";
  $("file-label").textContent = `${song.name} (from your songs)`;
  // With a saved stem, "separate" reuses it instantly.
  $("separate").checked = INSTRUMENTS.some((i) => song[SONG_FIELDS[i].stem]) || song.separated;
  const transcribed = INSTRUMENTS.filter((i) => song[SONG_FIELDS[i].result]);
  if (transcribed.length) setInstrumentChoice(transcribed.length > 1 ? "both" : transcribed[0]);
}

async function openSong(id) {
  const song = await getSong(id);
  if (!song) return;
  selectSong(song);
  show($("status"), false);
  showResult(song, [["Opened from your songs", "no processing"]]);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function historyItem(song) {
  const item = document.createElement("li");
  item.className = "flex flex-wrap items-center justify-between gap-2 px-4 py-3";
  const info = document.createElement("div");
  info.className = "min-w-0";
  const name = document.createElement("p");
  name.className = "truncate font-medium";
  name.textContent = song.name;
  const meta = document.createElement("p");
  meta.className = "text-xs text-stone-500";
  meta.textContent = [
    new Date(song.createdAt).toLocaleDateString(),
    song.duration ? formatDuration(song.duration) : null,
    ...describeStems(song),
  ]
    .filter(Boolean)
    .join(" · ");
  info.append(name, meta);

  const actions = document.createElement("div");
  actions.className = "flex gap-2 text-sm";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "rounded-lg border border-stone-300 px-3 py-1 hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800";
  open.textContent = "Open";
  open.addEventListener("click", () => openSong(song.id));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "rounded-lg px-3 py-1 text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950";
  remove.textContent = "Delete";
  remove.addEventListener("click", async () => {
    if (!confirm(`Delete "${song.name}" from your songs?`)) return;
    await deleteSong(song.id);
    if (currentSong?.id === song.id) currentSong = null;
    refreshHistory();
  });
  actions.append(open, remove);
  item.append(info, actions);
  return item;
}

function describeStems(song) {
  const stems = INSTRUMENTS.filter((i) => song[SONG_FIELDS[i].stem]).map((instrument) => {
    const blob = song[SONG_FIELDS[instrument].stem];
    return `${instrument} separated (${isOpusBlob(blob) ? "Opus" : "WAV"}, ${(blob.size / 1e6).toFixed(1)} MB)`;
  });
  return stems.length ? stems : ["not separated"];
}

function describeStorage({ usage, quota, persisted }) {
  const parts = [];
  if (usage !== null && quota !== null) parts.push(`${formatMegabytes(usage)} used of ${formatMegabytes(quota)} available`);
  else if (usage !== null) parts.push(`${formatMegabytes(usage)} used in this browser`);
  if (persisted === true) parts.push("kept until you delete it");
  else if (persisted === false) parts.push("the browser may clear it if space runs low");
  return parts.join(" · ");
}

function formatMegabytes(bytes) {
  return bytes >= 1e10 ? `${(bytes / 1e9).toFixed(0)} GB` : `${Math.round(bytes / 1e6).toLocaleString()} MB`;
}

async function refreshHistory() {
  const songs = await listSongs();
  $("history-list").replaceChildren(...songs.map(historyItem));
  show($("history-list"), songs.length > 0);
  show($("history-empty"), songs.length === 0);
  show($("export-history"), songs.length > 0);
  $("storage-usage").textContent = describeStorage(await storageInfo());
  return songs;
}

function historyMessage(text) {
  $("history-message").textContent = text;
}

async function exportHistory() {
  const songs = await listSongs();
  if (!songs.length) return;
  const date = new Date().toISOString().slice(0, 10);
  download(`bassline-to-tab-songs-${date}${ARCHIVE_EXTENSION}`, exportSongs(songs));
  historyMessage(`Exported ${songs.length} ${songs.length === 1 ? "song" : "songs"}.`);
}

async function importHistory(file) {
  historyMessage("Importing…");
  try {
    const imported = await importSongs(file);
    const existing = new Set((await listSongs()).map((song) => song.id));
    const duplicates = imported.filter((song) => existing.has(song.id));
    let toSave = imported;
    if (duplicates.length) {
      const replace = confirm(
        `${duplicates.length} of the imported songs ${duplicates.length === 1 ? "is" : "are"} already in your songs. ` +
          "Replace them with the imported version? (Cancel keeps yours and imports only the new ones.)",
      );
      if (!replace) toSave = imported.filter((song) => !existing.has(song.id));
    }
    await putSongs(toSave);
    const replacedCurrent = toSave.find((song) => song.id === currentSong?.id);
    if (replacedCurrent) currentSong = replacedCurrent;
    await refreshHistory();
    const skipped = imported.length - toSave.length;
    historyMessage(
      `Imported ${toSave.length} ${toSave.length === 1 ? "song" : "songs"}` + (skipped ? `, kept ${skipped} of yours.` : "."),
    );
  } catch (error) {
    console.error(error);
    historyMessage(`Could not import: ${error.message || error}`);
  }
}

// ─── Main flow ──────────────────────────────────────────────────────────────

/// Decodes a saved stem. Stems saved as WAV are compressed the first time
/// they are reused with compression on; the transcription still reads the
/// WAV this once.
async function loadSavedStem(song, instrument) {
  const field = SONG_FIELDS[instrument].stem;
  setStatus(`Loading the saved ${instrument}…`);
  const stem = await decodeBlob(song[field], SEPARATION_SAMPLE_RATE);
  if (compressBass() && !isOpusBlob(song[field])) {
    setStatus(`Compressing the saved ${instrument}…`);
    try {
      song[field] = await opusBlob(stem.left, stem.right, stem.sampleRate);
      await saveSong(song);
    } catch (error) {
      console.warn(`Could not compress the saved ${instrument}, keeping the WAV`, error);
    }
  }
  return stem;
}

/// Returns the audio to transcribe for each instrument (stereo at its own
/// rate) and updates the song record.
async function prepareSources(song, instruments, separate, timings, onProgress) {
  const sources = {};
  if (separate) {
    for (const instrument of instruments) {
      if (song[SONG_FIELDS[instrument].stem]) sources[instrument] = await loadSavedStem(song, instrument);
    }
    if (instruments.every((instrument) => sources[instrument])) {
      timings.push(["Separation", "reused"]);
      return sources;
    }
  }

  setStatus("Decoding audio…");
  setProgress(null);
  const started = performance.now();
  const mix = await decodeBlob(song.file, SEPARATION_SAMPLE_RATE);
  song.duration = mix.duration;
  timings.push(["Decode", formatSeconds((performance.now() - started) / 1000)]);
  if (!separate) {
    for (const instrument of instruments) sources[instrument] = mix;
    return sources;
  }

  const missing = instruments.filter((instrument) => !sources[instrument]);
  const model = missing.includes("guitar") ? GUITAR_MODEL : BASS_MODEL;
  // The 6-stem model separates the bass too: keep it if the song has none,
  // so transcribing the bass later needs no second separation.
  const stems = model === GUITAR_MODEL && !song.bassWav && !missing.includes("bass") ? [...missing, "bass"] : missing;
  setStatus(`Separating the ${missing.join(" and ")} with Demucs…`, { detail: "Preparing the GPU…" });
  const separated = await callWorker(
    "separate",
    { model, stems, left: mix.left, right: mix.right, sampleRate: mix.sampleRate },
    [mix.left.buffer, mix.right.buffer],
    onProgress,
  );
  timings.push(["Separation", formatSeconds(separated.seconds)]);
  if (compressBass()) setStatus("Compressing the separated tracks…");
  for (const [instrument, stem] of Object.entries(separated.stems)) {
    song[SONG_FIELDS[instrument].stem] = await bassBlob(stem.left, stem.right, separated.sampleRate);
    if (instruments.includes(instrument)) sources[instrument] = { ...stem, sampleRate: separated.sampleRate };
  }
  song.separated = true;
  await saveSong(song);
  return sources;
}

async function run(song) {
  const instruments = selectedInstruments();
  const separate = $("separate").checked;
  const timings = [];
  const started = performance.now();
  const onProgress = (event) => {
    setProgress(event.total ? event.done / event.total : null);
    $("progress").textContent = describeProgress(event);
  };

  const sources = await prepareSources(song, instruments, separate, timings, onProgress);

  const { transcriptionSampleRate } = await callWorker("info");
  for (const instrument of instruments) {
    setStatus(instruments.length > 1 ? `Detecting the ${instrument} notes…` : "Detecting notes…");
    setProgress(0);
    const options = readOptions(instrument);
    const source = sources[instrument];
    const mono = await toMono(source.left, source.right, source.sampleRate, transcriptionSampleRate);
    const transcribed = await callWorker("transcribe", { samples: mono, options }, [], onProgress);
    const label = instruments.length > 1 ? `Transcription (${instrument})` : "Transcription";
    timings.push([label, formatSeconds(transcribed.seconds)]);
    song[SONG_FIELDS[instrument].options] = options;
    song[SONG_FIELDS[instrument].result] = transcribed.result;
  }
  timings.push(["Total", formatSeconds((performance.now() - started) / 1000)]);

  song.separated = separate;
  await saveSong(song);
  refreshHistory();

  show($("status"), false);
  showResult(song, timings, instruments[0]);
}

async function songForSubmission() {
  const file = fileInput.files[0];
  if (!file) return currentSong;
  const id = songId(file);
  const saved = await getSong(id);
  return saved ?? { id, name: file.name, file, createdAt: Date.now(), bassWav: null, guitarWav: null, separated: false };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const song = await songForSubmission();
  if (!song) {
    setStatus("Choose a file first", { busy: false, error: "No audio file selected." });
    return;
  }
  currentSong = song;
  submitButton.disabled = true;
  try {
    await run(song);
  } catch (error) {
    console.error(error);
    // A panic inside WebAssembly leaves the module unusable; start clean.
    startWorker();
    setProgress(null);
    setStatus("Something went wrong", { busy: false, error: error.message || String(error) });
  } finally {
    submitButton.disabled = false;
  }
});

// ─── Static UI wiring ───────────────────────────────────────────────────────

fileInput.required = false;
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (file) currentSong = null;
  $("file-label").textContent = file?.name ?? "Tap to choose a file, or drop it here";
});

const drop = $("drop");
drop.addEventListener("dragover", (event) => {
  event.preventDefault();
  drop.classList.add("border-amber-500");
});
drop.addEventListener("dragleave", () => drop.classList.remove("border-amber-500"));
drop.addEventListener("drop", (event) => {
  event.preventDefault();
  drop.classList.remove("border-amber-500");
  if (event.dataTransfer.files.length) {
    fileInput.files = event.dataTransfer.files;
    fileInput.dispatchEvent(new Event("change"));
  }
});

for (const [select, custom] of [
  ["tuning", "tuning-custom"],
  ["guitar-tuning", "guitar-tuning-custom"],
]) {
  $(select).addEventListener("change", () => {
    const isCustom = $(select).value === "custom";
    $(custom).hidden = !isCustom;
    $(custom).required = isCustom;
  });
}

form.querySelectorAll('input[name="instrument"]').forEach((input) => input.addEventListener("change", showTuningFields));
showTuningFields();

$("onset-threshold").addEventListener("input", () => {
  $("onset-value").textContent = parseFloat($("onset-threshold").value).toFixed(2);
});

$("copy").addEventListener("click", async () => {
  if (!currentResult) return;
  await navigator.clipboard.writeText(currentFingering().tab);
  $("copy").textContent = "Copied";
  setTimeout(() => ($("copy").textContent = "Copy"), 1500);
});

$("compress-bass").addEventListener("change", () => {
  try {
    localStorage.setItem(COMPRESS_BASS_KEY, $("compress-bass").checked ? "1" : "0");
  } catch {
    // Not saved in a private window; the choice lasts until reload.
  }
});

opusSupported().then((supported) => {
  const checkbox = $("compress-bass");
  if (!supported) {
    checkbox.checked = false;
    checkbox.disabled = true;
    $("compress-bass-hint").textContent = "This browser cannot encode Opus, so the bass is saved as WAV.";
    return;
  }
  try {
    checkbox.checked = localStorage.getItem(COMPRESS_BASS_KEY) === "1";
  } catch {
    // Storage blocked: keep the default (off).
  }
});

$("export-history").addEventListener("click", exportHistory);

$("import-history").addEventListener("change", async () => {
  const file = $("import-history").files[0];
  $("import-history").value = "";
  if (file) await importHistory(file);
});

$("download-tab").addEventListener("click", () => {
  if (currentResult) {
    const { style, tab } = currentFingering();
    const suffix = (currentInstrument === "guitar" ? ".guitar" : "") + (style === "open-position" ? "" : `.${style}`);
    download(`${baseName(currentSong?.name ?? "bassline")}${suffix}.tab.txt`, new Blob([tab], { type: "text/plain" }));
  }
});

$("download-midi").addEventListener("click", () => {
  if (currentResult) {
    const suffix = currentInstrument === "guitar" ? ".guitar" : "";
    const midi = new Blob([currentResult.midi], { type: "audio/midi" });
    download(`${baseName(currentSong?.name ?? "bassline")}${suffix}.mid`, midi);
  }
});

callWorker("info")
  .then(({ weightsSizeMb, guitarWeightsSizeMb }) => {
    $("weights-size").textContent = String(weightsSizeMb);
    $("guitar-weights-size").textContent = String(guitarWeightsSizeMb);
  })
  .catch((error) => setStatus("Could not start the app", { busy: false, error: error.message }));

hasWebGpu().then((available) => {
  if (available) return;
  $("separate").checked = false;
  const warning = $("gpu-warning");
  warning.textContent =
    "This browser has no WebGPU, so the instruments cannot be separated here. You can still transcribe an isolated bass or guitar recording.";
  show(warning, true);
});

refreshHistory();
