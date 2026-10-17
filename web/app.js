// Main thread: UI, audio decoding (Web Audio API) and talking to the worker.
// The heavy lifting (Demucs, Basic Pitch) runs in worker.js.

const SEPARATION_SAMPLE_RATE = 44100;
/// Approximate width of one 4/4 bar of tab, in characters.
const BAR_WIDTH_CHARS = 34;

const $ = (id) => document.getElementById(id);

const form = $("form");
const fileInput = $("audio");
const submitButton = $("submit");

// ─── Worker requests ────────────────────────────────────────────────────────

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const pending = new Map();
let nextRequestId = 1;

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
  for (const request of pending.values()) request.reject(new Error(event.message || "The worker crashed"));
  pending.clear();
};

function callWorker(type, payload = {}, transfer = [], onProgress = null) {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, type, ...payload }, transfer);
  });
}

// ─── UI helpers ─────────────────────────────────────────────────────────────

function show(element, visible) {
  element.classList.toggle("hidden", !visible);
}

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

function barsPerLine() {
  const tab = $("tab");
  const width = tab.clientWidth || document.body.clientWidth;
  const charWidth = parseFloat(getComputedStyle(tab).fontSize) * 0.6;
  return Math.max(1, Math.floor((width / charWidth - 4) / BAR_WIDTH_CHARS));
}

function readOptions() {
  const bpm = parseFloat($("bpm").value);
  return {
    tuning: tuningValue(),
    frets: parseInt($("frets").value, 10) || 24,
    bpm: Number.isFinite(bpm) ? bpm : null,
    onsetThreshold: parseFloat($("onset-threshold").value),
    minNoteMs: parseFloat($("min-note").value) || 80,
    barsPerLine: barsPerLine(),
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

// ─── Audio ──────────────────────────────────────────────────────────────────

async function decodeFile(file, sampleRate) {
  const bytes = await file.arrayBuffer();
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

function wavBlob(left, right, sampleRate) {
  const frames = left.length;
  const view = new DataView(new ArrayBuffer(44 + frames * 4));
  const writeString = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  writeString(0, "RIFF");
  view.setUint32(4, 36 + frames * 4, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) {
    view.setInt16(44 + i * 4, Math.max(-1, Math.min(1, left[i])) * 0x7fff, true);
    view.setInt16(46 + i * 4, Math.max(-1, Math.min(1, right[i])) * 0x7fff, true);
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

// ─── Results ────────────────────────────────────────────────────────────────

let lastResult = null;
let lastFileName = "bassline";

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
    ...items.flatMap(([label, value]) => {
      const term = document.createElement("dt");
      term.className = "text-stone-500";
      term.textContent = label;
      const definition = document.createElement("dd");
      definition.className = "font-medium";
      definition.textContent = value;
      const wrapper = document.createElement("div");
      wrapper.append(term, definition);
      return [wrapper];
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

function showResult(result, bassStem, timings) {
  lastResult = result;
  renderSummary(result);
  $("tab").textContent = result.tab;
  const player = $("bass-player");
  if (bassStem) {
    if (player.src) URL.revokeObjectURL(player.src);
    player.src = URL.createObjectURL(wavBlob(bassStem.left, bassStem.right, bassStem.sampleRate));
  }
  show($("bass-player-box"), Boolean(bassStem));
  $("timings").textContent = timings.map(([label, seconds]) => `${label}: ${formatSeconds(seconds)}`).join(" · ");
  show($("result"), true);
}

// ─── Main flow ──────────────────────────────────────────────────────────────

async function run(file) {
  const options = readOptions();
  const separate = $("separate").checked;
  const timings = [];
  const onProgress = (event) => {
    setProgress(event.total ? event.done / event.total : null);
    $("progress").textContent = describeProgress(event);
  };

  setStatus("Decoding audio…");
  setProgress(null);
  const started = performance.now();
  const mix = await decodeFile(file, SEPARATION_SAMPLE_RATE);
  timings.push(["Decode", (performance.now() - started) / 1000]);
  console.info(`Decoded ${file.name}: ${mix.duration.toFixed(1)} s`);

  let bassStem = null;
  let source = mix;
  if (separate) {
    setStatus("Separating the bass with Demucs…", { detail: "Preparing the GPU…" });
    const separated = await callWorker(
      "separate",
      { left: mix.left, right: mix.right, sampleRate: mix.sampleRate },
      [mix.left.buffer, mix.right.buffer],
      onProgress,
    );
    timings.push(["Separation", separated.seconds]);
    bassStem = { left: separated.left, right: separated.right, sampleRate: separated.sampleRate };
    source = bassStem;
  }

  setStatus("Detecting notes…");
  setProgress(0);
  const { transcriptionSampleRate } = await callWorker("info");
  const mono = await toMono(source.left, source.right, source.sampleRate, transcriptionSampleRate);
  const transcribed = await callWorker("transcribe", { samples: mono, options }, [], onProgress);
  timings.push(["Transcription", transcribed.seconds]);
  timings.push(["Total", (performance.now() - started) / 1000]);

  show($("status"), false);
  showResult(transcribed.result, bassStem, timings);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file) return;
  lastFileName = file.name.replace(/\.[^.]+$/, "") || "bassline";
  submitButton.disabled = true;
  show($("result"), false);
  try {
    await run(file);
  } catch (error) {
    console.error(error);
    setProgress(null);
    setStatus("Something went wrong", { busy: false, error: error.message || String(error) });
  } finally {
    submitButton.disabled = false;
  }
});

// ─── Static UI wiring ───────────────────────────────────────────────────────

fileInput.addEventListener("change", () => {
  $("file-label").textContent = fileInput.files[0]?.name ?? "Tap to choose a file, or drop it here";
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
  if (!lastResult) return;
  await navigator.clipboard.writeText(lastResult.tab);
  $("copy").textContent = "Copied";
  setTimeout(() => ($("copy").textContent = "Copy"), 1500);
});

$("download-tab").addEventListener("click", () => {
  if (lastResult) download(`${lastFileName}.tab.txt`, new Blob([lastResult.tab], { type: "text/plain" }));
});

$("download-midi").addEventListener("click", () => {
  if (lastResult) download(`${lastFileName}.mid`, new Blob([lastResult.midi], { type: "audio/midi" }));
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
