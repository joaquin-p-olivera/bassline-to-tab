// Main thread: UI, audio decoding (Web Audio API), song history and talking
// to the worker. The heavy lifting (Demucs, Basic Pitch) runs in worker.js.

import { deleteSong, getSong, listSongs, saveSong, songId, storageUsage } from "./storage.js";
import { TabView } from "./tab-view.js";

const SEPARATION_SAMPLE_RATE = 44100;
/// Bars per line in the downloadable .txt tab.
const TEXT_TAB_BARS_PER_LINE = 4;

const $ = (id) => document.getElementById(id);

const form = $("form");
const fileInput = $("audio");
const submitButton = $("submit");
const player = $("player");
const tabView = new TabView($("tab-view"));

/// The song being worked on: a history record (see storage.js).
let currentSong = null;
let currentResult = null;
let playerUrls = { bass: null, mix: null };

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
      return `Separating the bass: chunk ${done} of ${total}`;
    case "transcribe":
      return `Detecting notes: window ${done} of ${total}`;
    default:
      return "";
  }
}

function tuningValue() {
  const selected = $("tuning").value;
  return selected === "custom" ? $("tuning-custom").value.trim() : selected;
}

function readOptions() {
  const bpm = parseFloat($("bpm").value);
  return {
    tuning: tuningValue(),
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

/// 16-bit mono WAV; the bass stem is stored this way to keep the history small.
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
  playerUrls = {
    bass: song.bassWav ? URL.createObjectURL(song.bassWav) : null,
    mix: URL.createObjectURL(song.file),
  };
  for (const button of document.querySelectorAll(".source-button")) {
    button.disabled = !playerUrls[button.dataset.source];
    button.classList.toggle("opacity-40", button.disabled);
  }
  selectSource(playerUrls.bass ? "bass" : "mix");
}

function selectSource(source) {
  const url = playerUrls[source];
  if (!url) return;
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
  tabView.setTime(player.currentTime);
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
    ["Bass tuning", result.tuning],
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

function showResult(song, result, timings = []) {
  currentResult = result;
  renderSummary(result);
  show($("result"), true);
  setPlayerSources(song);
  tabView.setTranscription(result);
  tabView.setTime(player.currentTime || 0);
  $("timings").textContent = timings.map(([label, value]) => `${label}: ${value}`).join(" · ");
}

// ─── History ────────────────────────────────────────────────────────────────

function selectSong(song) {
  currentSong = song;
  fileInput.value = "";
  $("file-label").textContent = `${song.name} (from your songs)`;
  // With a saved bass stem, "separate" reuses it instantly.
  $("separate").checked = Boolean(song.bassWav) || song.separated;
}

async function openSong(id) {
  const song = await getSong(id);
  if (!song) return;
  selectSong(song);
  show($("status"), false);
  if (song.lastResult) {
    showResult(song, song.lastResult, [["Opened from your songs", "no processing"]]);
  } else {
    show($("result"), false);
  }
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
    song.bassWav ? "bass separated" : "not separated",
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

async function refreshHistory() {
  const songs = await listSongs();
  $("history-list").replaceChildren(...songs.map(historyItem));
  show($("history"), songs.length > 0);
  const usage = await storageUsage();
  $("storage-usage").textContent = usage === null ? "" : `${(usage / 1e6).toFixed(0)} MB used in this browser`;
}

// ─── Main flow ──────────────────────────────────────────────────────────────

/// Returns the audio to transcribe (stereo at its own rate) and updates the song record.
async function prepareSource(song, separate, timings, onProgress) {
  if (separate && song.bassWav) {
    setStatus("Loading the saved bass…");
    const bass = await decodeBlob(song.bassWav, SEPARATION_SAMPLE_RATE);
    timings.push(["Separation", "reused"]);
    return bass;
  }

  setStatus("Decoding audio…");
  setProgress(null);
  const started = performance.now();
  const mix = await decodeBlob(song.file, SEPARATION_SAMPLE_RATE);
  song.duration = mix.duration;
  timings.push(["Decode", formatSeconds((performance.now() - started) / 1000)]);
  if (!separate) return mix;

  setStatus("Separating the bass with Demucs…", { detail: "Preparing the GPU…" });
  const separated = await callWorker(
    "separate",
    { left: mix.left, right: mix.right, sampleRate: mix.sampleRate },
    [mix.left.buffer, mix.right.buffer],
    onProgress,
  );
  timings.push(["Separation", formatSeconds(separated.seconds)]);
  song.bassWav = monoWavBlob(separated.left, separated.right, separated.sampleRate);
  song.separated = true;
  await saveSong(song);
  return { left: separated.left, right: separated.right, sampleRate: separated.sampleRate };
}

async function run(song) {
  const options = readOptions();
  const separate = $("separate").checked;
  const timings = [];
  const started = performance.now();
  const onProgress = (event) => {
    setProgress(event.total ? event.done / event.total : null);
    $("progress").textContent = describeProgress(event);
  };

  const source = await prepareSource(song, separate, timings, onProgress);

  setStatus("Detecting notes…");
  setProgress(0);
  const { transcriptionSampleRate } = await callWorker("info");
  const mono = await toMono(source.left, source.right, source.sampleRate, transcriptionSampleRate);
  const transcribed = await callWorker("transcribe", { samples: mono, options }, [], onProgress);
  timings.push(["Transcription", formatSeconds(transcribed.seconds)]);
  timings.push(["Total", formatSeconds((performance.now() - started) / 1000)]);

  song.lastOptions = options;
  song.lastResult = transcribed.result;
  song.separated = separate;
  await saveSong(song);
  refreshHistory();

  show($("status"), false);
  showResult(song, transcribed.result, timings);
}

async function songForSubmission() {
  const file = fileInput.files[0];
  if (!file) return currentSong;
  const id = songId(file);
  const saved = await getSong(id);
  return saved ?? { id, name: file.name, file, createdAt: Date.now(), bassWav: null, separated: false };
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

$("tuning").addEventListener("change", () => {
  const custom = $("tuning").value === "custom";
  $("tuning-custom").hidden = !custom;
  $("tuning-custom").required = custom;
});

$("onset-threshold").addEventListener("input", () => {
  $("onset-value").textContent = parseFloat($("onset-threshold").value).toFixed(2);
});

$("copy").addEventListener("click", async () => {
  if (!currentResult) return;
  await navigator.clipboard.writeText(currentResult.tab);
  $("copy").textContent = "Copied";
  setTimeout(() => ($("copy").textContent = "Copy"), 1500);
});

$("download-tab").addEventListener("click", () => {
  if (currentResult) {
    download(`${baseName(currentSong?.name ?? "bassline")}.tab.txt`, new Blob([currentResult.tab], { type: "text/plain" }));
  }
});

$("download-midi").addEventListener("click", () => {
  if (currentResult) {
    download(`${baseName(currentSong?.name ?? "bassline")}.mid`, new Blob([currentResult.midi], { type: "audio/midi" }));
  }
});

callWorker("info")
  .then(({ weightsSizeMb }) => ($("weights-size").textContent = String(weightsSizeMb)))
  .catch((error) => setStatus("Could not start the app", { busy: false, error: error.message }));

hasWebGpu().then((available) => {
  if (available) return;
  $("separate").checked = false;
  const warning = $("gpu-warning");
  warning.textContent =
    "This browser has no WebGPU, so the bass cannot be separated here. You can still transcribe an isolated bass recording.";
  show(warning, true);
});

refreshHistory();
