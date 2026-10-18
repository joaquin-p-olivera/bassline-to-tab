// Bass amp page: records the bass with the microphone, then plays the take
// through a compressor, a drive pedal and a three-band amp EQ (all Web Audio
// nodes), so the controls change the sound while it plays. The same chain,
// built on an OfflineAudioContext, renders the .wav download.

const SETTINGS_KEY = "amp.settings";
const MAX_RECORD_SECONDS = 120;
/// The take is scaled to this peak, so the drive and compressor controls
/// behave the same however loud the microphone picked it up.
const TAKE_PEAK = 0.5;
/// How long a control change takes to settle (avoids clicks).
const RAMP_SECONDS = 0.015;
const COMP_KNEE_DB = 6;
const BASS_HZ = 80;
const TREBLE_HZ = 3000;
const MID_Q = 0.8;
const CURVE_SAMPLES = 2048;
/// The EQ graph's range.
const GRAPH_MIN_HZ = 20;
const GRAPH_MAX_HZ = 16000;
const GRAPH_DB = 18;

/// Sliders, grouped by the panel that holds them. `log` sliders move
/// evenly in octaves rather than in hertz.
const CONTROLS = {
  comp: [
    { key: "compThreshold", label: "Threshold", min: -50, max: 0, step: 1, unit: "dB", value: -24 },
    { key: "compRatio", label: "Ratio", min: 1, max: 20, step: 0.5, unit: ":1", value: 4 },
    { key: "compAttack", label: "Attack", min: 1, max: 100, step: 1, unit: "ms", value: 10 },
    { key: "compRelease", label: "Release", min: 50, max: 1000, step: 10, unit: "ms", value: 250 },
    { key: "compLevel", label: "Level", min: -12, max: 18, step: 0.5, unit: "dB", value: 6 },
  ],
  drive: [
    { key: "driveAmount", label: "Drive", min: 0, max: 100, step: 1, unit: "%", value: 40 },
    { key: "driveTone", label: "Tone", min: 300, max: 8000, log: true, unit: "Hz", value: 2500 },
    { key: "driveBlend", label: "Blend (clean ↔ driven)", min: 0, max: 100, step: 1, unit: "%", value: 60 },
    { key: "driveLevel", label: "Level", min: -18, max: 12, step: 0.5, unit: "dB", value: 0 },
  ],
  amp: [
    { key: "bass", label: `Bass (${BASS_HZ} Hz)`, min: -15, max: 15, step: 0.5, unit: "dB", value: 0 },
    { key: "treble", label: `Treble (${TREBLE_HZ / 1000} kHz)`, min: -15, max: 15, step: 0.5, unit: "dB", value: 0 },
    { key: "mid", label: "Middle", min: -15, max: 15, step: 0.5, unit: "dB", value: 0 },
    { key: "midFreq", label: "Middle frequency", min: 200, max: 2500, log: true, unit: "Hz", value: 500 },
    { key: "master", label: "Master volume", min: -30, max: 6, step: 0.5, unit: "dB", value: 0 },
  ],
};
const ALL_CONTROLS = Object.values(CONTROLS).flat();
const DEFAULTS = {
  ...Object.fromEntries(ALL_CONTROLS.map((c) => [c.key, c.value])),
  compOn: false,
  driveOn: true,
  driveType: "overdrive",
};
const LOG_STEPS = 1000;

/// Clipping curves, each mapping [-1, 1] onto [-1, 1] before normalizing.
/// `gain` grows with the Drive control.
const DRIVES = {
  // Smooth saturation, like a tube or a soft-clipping pedal.
  overdrive: { gain: (a) => 1 + 20 * a * a, shape: (x) => Math.tanh(x) },
  // Close to hard clipping: flat tops with a slightly rounded knee.
  distortion: { gain: (a) => 1 + 60 * a * a, shape: (x) => x / Math.pow(1 + x ** 6, 1 / 6) },
  // Asymmetric and very hot: squares the wave and adds even harmonics.
  fuzz: {
    gain: (a) => 3 + 150 * a * a,
    shape: (x) => (x >= 0 ? x / Math.pow(1 + x ** 8, 1 / 8) : 0.6 * Math.tanh(x / 0.6)),
  },
};

const $ = (id) => document.getElementById(id);

/// Uses both Tailwind's class and the native attribute, so visibility works
/// even if the Tailwind CDN fails to load.
function show(element, visible) {
  element.classList.toggle("hidden", !visible);
  element.hidden = !visible;
}

for (const element of document.querySelectorAll(".hidden")) element.hidden = true;

const dbToGain = (db) => 10 ** (db / 20);

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ─── Settings ───────────────────────────────────────────────────────────────

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    const settings = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof saved[key] === typeof DEFAULTS[key]) settings[key] = saved[key];
    }
    if (!DRIVES[settings.driveType]) settings.driveType = DEFAULTS.driveType;
    return settings;
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Not remembered; the page works the same.
  }
}

let settings = loadSettings();

// ─── The effect chain ───────────────────────────────────────────────────────

/// The normalized clipping curve for the current drive settings, and the
/// gain that brings a full-level take back to the clean signal's loudness.
function driveCurve(type, amount) {
  const { gain, shape } = DRIVES[type];
  const g = gain(amount / 100);
  const raw = (x) => shape(g * x);
  const peak = Math.max(Math.abs(raw(1)), Math.abs(raw(-1)));
  const curve = new Float32Array(CURVE_SAMPLES);
  for (let i = 0; i < CURVE_SAMPLES; i++) {
    curve[i] = raw((2 * i) / (CURVE_SAMPLES - 1) - 1) / peak;
  }
  const atTake = Math.max(Math.abs(raw(TAKE_PEAK)), Math.abs(raw(-TAKE_PEAK))) / peak;
  return { curve, makeup: TAKE_PEAK / atTake };
}

/// A stage that crossfades between its effect and a straight wire, so
/// switching it on or off never reconnects nodes mid-playback.
function bypassable(ctx, first, last) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const wet = ctx.createGain();
  const dry = ctx.createGain();
  input.connect(first);
  last.connect(wet).connect(output);
  input.connect(dry).connect(output);
  return { input, output, wet, dry };
}

/// Builds compressor → drive → EQ → master on `ctx`. `apply` sets every
/// parameter from the settings; `immediate` skips the smoothing (offline).
function buildChain(ctx) {
  const compressor = ctx.createDynamicsCompressor();
  compressor.knee.value = COMP_KNEE_DB;
  const compLevel = ctx.createGain();
  compressor.connect(compLevel);
  const comp = bypassable(ctx, compressor, compLevel);

  // The drive splits into a clean path and a clipped one: blending some clean
  // signal back in keeps the low end that clipping eats.
  const split = ctx.createGain();
  const clean = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  shaper.oversample = "4x";
  const dcBlock = ctx.createBiquadFilter();
  dcBlock.type = "highpass";
  dcBlock.frequency.value = 25;
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.Q.value = 0.7;
  const driven = ctx.createGain();
  const driveLevel = ctx.createGain();
  split.connect(clean).connect(driveLevel);
  split.connect(shaper).connect(dcBlock).connect(tone).connect(driven).connect(driveLevel);
  const drive = bypassable(ctx, split, driveLevel);

  const bass = ctx.createBiquadFilter();
  bass.type = "lowshelf";
  bass.frequency.value = BASS_HZ;
  const mid = ctx.createBiquadFilter();
  mid.type = "peaking";
  mid.Q.value = MID_Q;
  const treble = ctx.createBiquadFilter();
  treble.type = "highshelf";
  treble.frequency.value = TREBLE_HZ;
  bass.connect(mid).connect(treble);

  comp.output.connect(drive.input);
  drive.output.connect(bass);
  const effects = bypassable(ctx, comp.input, treble);

  const master = ctx.createGain();
  effects.output.connect(master);

  let shapedFor = null;

  function apply(s, { immediate = false, bypassAll = false } = {}) {
    const set = (param, value) => {
      if (immediate) param.value = value;
      else param.setTargetAtTime(value, ctx.currentTime, RAMP_SECONDS);
    };
    const toggle = (stage, on) => {
      set(stage.wet.gain, on ? 1 : 0);
      set(stage.dry.gain, on ? 0 : 1);
    };
    toggle(effects, !bypassAll);

    toggle(comp, s.compOn);
    set(compressor.threshold, s.compThreshold);
    set(compressor.ratio, s.compRatio);
    set(compressor.attack, s.compAttack / 1000);
    set(compressor.release, s.compRelease / 1000);
    set(compLevel.gain, dbToGain(s.compLevel));

    toggle(drive, s.driveOn);
    const shapeKey = `${s.driveType}:${s.driveAmount}`;
    const { curve, makeup } = driveCurve(s.driveType, s.driveAmount);
    if (shapeKey !== shapedFor) {
      shaper.curve = curve;
      shapedFor = shapeKey;
    }
    const blend = s.driveBlend / 100;
    set(clean.gain, 1 - blend);
    set(driven.gain, blend * makeup);
    set(tone.frequency, s.driveTone);
    set(driveLevel.gain, dbToGain(s.driveLevel));

    set(bass.gain, s.bass);
    set(mid.gain, s.mid);
    set(mid.frequency, s.midFreq);
    set(treble.gain, s.treble);
    set(master.gain, dbToGain(s.master));
  }

  return { input: effects.input, output: master, compressor, eq: [bass, mid, treble], apply };
}

// ─── Live audio ─────────────────────────────────────────────────────────────

let audioContext = null;
let chain = null;
let analyser = null;
let bypassAll = false;

function context() {
  if (!audioContext) {
    audioContext = new AudioContext({ latencyHint: "interactive" });
    chain = buildChain(audioContext);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0.8;
    chain.output.connect(analyser);
    chain.output.connect(audioContext.destination);
    chain.apply(settings, { immediate: true, bypassAll });
  }
  // Browsers start the context suspended until a user gesture.
  if (audioContext.state === "suspended") audioContext.resume();
  return audioContext;
}

function applySettings() {
  saveSettings();
  if (chain) chain.apply(settings, { bypassAll });
  drawStatic();
}

// ─── Recording ──────────────────────────────────────────────────────────────

let recorder = null;
let take = null;

$("record").addEventListener("click", () => (recorder ? stopRecording() : startRecording()));

async function startRecording() {
  show($("mic-error"), false);
  if (!window.MediaRecorder) {
    showMicError("This browser cannot record audio. Try a recent Chrome, Edge, Firefox or Safari.");
    return;
  }
  const ctx = context();
  let stream;
  try {
    // Echo cancellation and automatic gain would pump and filter the bass.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (error) {
    showMicError(
      error.name === "NotAllowedError"
        ? "The microphone is blocked. Allow it for this page in the browser settings and try again."
        : `Could not open the microphone: ${error.message}`,
    );
    return;
  }
  stopPlayback();

  const chunks = [];
  const mediaRecorder = new MediaRecorder(stream);
  const meter = ctx.createAnalyser();
  meter.fftSize = 2048;
  const micSource = ctx.createMediaStreamSource(stream);
  micSource.connect(meter);
  const samples = new Float32Array(meter.fftSize);
  const startedAt = performance.now();

  recorder = { mediaRecorder, stream, frame: 0 };
  mediaRecorder.addEventListener("dataavailable", (event) => chunks.push(event.data));
  mediaRecorder.addEventListener("stop", async () => {
    micSource.disconnect();
    for (const track of stream.getTracks()) track.stop();
    cancelAnimationFrame(recorder.frame);
    recorder = null;
    show($("recording"), false);
    try {
      const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
      const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
      setTake(normalized(ctx, decoded));
    } catch (error) {
      showMicError(`Could not read the recording: ${error.message}`);
    }
    $("record").textContent = take ? "Record again" : "Record";
  });
  mediaRecorder.start();

  $("record").textContent = "Stop";
  $("record-time").textContent = "0:00";
  show($("recording"), true);

  const tick = () => {
    const elapsed = (performance.now() - startedAt) / 1000;
    $("record-time").textContent = formatTime(elapsed);
    meter.getFloatTimeDomainData(samples);
    let peak = 0;
    for (const v of samples) peak = Math.max(peak, Math.abs(v));
    $("input-level").style.width = `${Math.min(100, peak * 100)}%`;
    $("input-level").classList.toggle("bg-red-500", peak > 0.98);
    if (elapsed >= MAX_RECORD_SECONDS) stopRecording();
    else recorder.frame = requestAnimationFrame(tick);
  };
  recorder.frame = requestAnimationFrame(tick);
}

function stopRecording() {
  if (recorder?.mediaRecorder.state === "recording") recorder.mediaRecorder.stop();
}

function showMicError(message) {
  $("mic-error").textContent = message;
  show($("mic-error"), true);
}

/// Mixes the recording to mono and scales it to TAKE_PEAK.
function normalized(ctx, decoded) {
  const mono = new Float32Array(decoded.length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const channel = decoded.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / decoded.numberOfChannels;
  }
  let peak = 0;
  for (const v of mono) peak = Math.max(peak, Math.abs(v));
  const scale = peak > 0 ? TAKE_PEAK / peak : 1;
  for (let i = 0; i < mono.length; i++) mono[i] *= scale;
  const buffer = ctx.createBuffer(1, mono.length, decoded.sampleRate);
  buffer.copyToChannel(mono, 0);
  return buffer;
}

function setTake(buffer) {
  take = buffer;
  playback.offset = 0;
  $("duration").textContent = formatTime(buffer.duration);
  $("position").textContent = "0:00";
  show($("player"), true);
  waveformPeaks = null;
  drawWaveform();
}

// ─── Playback ───────────────────────────────────────────────────────────────

const playback = { source: null, startedAt: 0, offset: 0, frame: 0 };

$("play").addEventListener("click", () => (playback.source ? pausePlayback() : startPlayback(playback.offset)));

$("loop").addEventListener("change", (event) => {
  if (playback.source) playback.source.loop = event.target.checked;
});

$("bypass").addEventListener("click", () => {
  bypassAll = !bypassAll;
  $("bypass").setAttribute("aria-pressed", String(bypassAll));
  $("bypass").classList.toggle("bg-amber-600", bypassAll);
  $("bypass").classList.toggle("text-white", bypassAll);
  $("bypass").classList.toggle("border-amber-600", bypassAll);
  if (chain) chain.apply(settings, { bypassAll });
});

function startPlayback(from) {
  if (!take) return;
  const ctx = context();
  stopSource();
  const source = ctx.createBufferSource();
  source.buffer = take;
  source.loop = $("loop").checked;
  source.connect(chain.input);
  source.addEventListener("ended", () => {
    if (playback.source !== source) return;
    playback.source = null;
    playback.offset = 0;
    playbackStopped();
  });
  const offset = from >= take.duration ? 0 : from;
  source.start(0, offset);
  playback.source = source;
  playback.startedAt = ctx.currentTime - offset;
  $("play").textContent = "Pause";
  cancelAnimationFrame(playback.frame);
  playback.frame = requestAnimationFrame(animate);
}

function position() {
  if (!playback.source) return playback.offset;
  const elapsed = audioContext.currentTime - playback.startedAt;
  return playback.source.loop ? elapsed % take.duration : Math.min(elapsed, take.duration);
}

function stopSource() {
  const source = playback.source;
  playback.source = null;
  if (source) {
    source.stop();
    source.disconnect();
  }
}

function pausePlayback() {
  playback.offset = position();
  stopSource();
  playbackStopped();
}

function stopPlayback() {
  stopSource();
  playback.offset = 0;
  playbackStopped();
}

function playbackStopped() {
  $("play").textContent = "Play";
  cancelAnimationFrame(playback.frame);
  $("position").textContent = formatTime(playback.offset);
  drawWaveform();
  drawStatic();
  showReduction(0);
}

$("waveform").addEventListener("click", (event) => {
  if (!take) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const at = ((event.clientX - rect.left) / rect.width) * take.duration;
  if (playback.source) startPlayback(at);
  else {
    playback.offset = at;
    $("position").textContent = formatTime(at);
    drawWaveform();
  }
});

function animate() {
  $("position").textContent = formatTime(position());
  drawWaveform();
  drawEq(true);
  showReduction(chain.compressor.reduction);
  playback.frame = requestAnimationFrame(animate);
}

function showReduction(db) {
  const value = settings.compOn && !bypassAll ? Math.abs(db) : 0;
  $("reduction").textContent = `${value > 0.05 ? "−" : ""}${value.toFixed(1)} dB`;
  $("reduction-bar").style.width = `${Math.min(100, (value / 24) * 100)}%`;
}

// ─── Download ───────────────────────────────────────────────────────────────

$("download").addEventListener("click", async () => {
  if (!take) return;
  const button = $("download");
  button.disabled = true;
  button.textContent = "Rendering…";
  try {
    const offline = new OfflineAudioContext(1, take.length, take.sampleRate);
    const offlineChain = buildChain(offline);
    offlineChain.apply(settings, { immediate: true, bypassAll });
    offlineChain.output.connect(offline.destination);
    const source = offline.createBufferSource();
    source.buffer = take;
    source.connect(offlineChain.input);
    source.start();
    const rendered = await offline.startRendering();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(wavBlob(rendered));
    link.download = "bass-amp.wav";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  } finally {
    button.disabled = false;
    button.textContent = "Download .wav";
  }
});

/// 16-bit mono PCM WAV.
function wavBlob(buffer) {
  const samples = buffer.getChannelData(0);
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (offset, s) => [...s].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([view], { type: "audio/wav" });
}

// ─── Controls ───────────────────────────────────────────────────────────────

function formatValue(control, value) {
  if (control.unit === "Hz") return value >= 1000 ? `${(value / 1000).toFixed(1)} kHz` : `${Math.round(value)} Hz`;
  if (control.unit === "dB") return `${value > 0 ? "+" : ""}${value.toFixed(1)} dB`;
  if (control.unit === ":1") return `${value}:1`;
  return `${value} ${control.unit}`;
}

const toSlider = (c, value) =>
  c.log ? Math.round((Math.log(value / c.min) / Math.log(c.max / c.min)) * LOG_STEPS) : value;
const fromSlider = (c, position) => (c.log ? Math.round(c.min * (c.max / c.min) ** (position / LOG_STEPS)) : position);

const sliders = new Map();

for (const [group, controls] of Object.entries(CONTROLS)) {
  const container = document.querySelector(`[data-controls="${group}"]`);
  for (const control of controls) {
    const label = document.createElement("label");
    label.className = "block text-sm";
    const head = document.createElement("span");
    head.className = "flex justify-between gap-2";
    const name = document.createElement("span");
    name.className = "font-medium";
    name.textContent = control.label;
    const readout = document.createElement("span");
    readout.className = "font-mono text-stone-500";
    head.append(name, readout);
    const input = document.createElement("input");
    input.type = "range";
    input.className = "mt-1 w-full accent-amber-600";
    input.min = control.log ? 0 : control.min;
    input.max = control.log ? LOG_STEPS : control.max;
    input.step = control.log ? 1 : control.step;
    input.addEventListener("input", () => {
      settings[control.key] = fromSlider(control, Number(input.value));
      readout.textContent = formatValue(control, settings[control.key]);
      applySettings();
    });
    // Double-click puts a control back to its default.
    input.addEventListener("dblclick", () => {
      settings[control.key] = control.value;
      syncControls();
      applySettings();
    });
    label.append(head, input);
    container.append(label);
    sliders.set(control.key, { control, input, readout });
  }
}

for (const button of document.querySelectorAll("[data-switch]")) {
  button.addEventListener("click", () => {
    settings[button.dataset.switch] = !settings[button.dataset.switch];
    syncControls();
    applySettings();
  });
}

for (const button of document.querySelectorAll(".drive-type")) {
  button.addEventListener("click", () => {
    settings.driveType = button.dataset.drive;
    syncControls();
    applySettings();
  });
}

$("reset").addEventListener("click", () => {
  settings = { ...DEFAULTS };
  syncControls();
  applySettings();
});

function syncControls() {
  for (const { control, input, readout } of sliders.values()) {
    input.value = toSlider(control, settings[control.key]);
    readout.textContent = formatValue(control, settings[control.key]);
  }
  for (const button of document.querySelectorAll("[data-switch]")) {
    const on = settings[button.dataset.switch];
    button.setAttribute("aria-pressed", String(on));
    button.querySelector(".switch-label").textContent = on ? "On" : "Off";
    // The panel's sliders stay usable while off, but look inactive.
    const group = button.dataset.switch === "compOn" ? "comp" : "drive";
    document.querySelector(`[data-controls="${group}"]`).classList.toggle("opacity-50", !on);
  }
  for (const button of document.querySelectorAll(".drive-type")) {
    const selected = button.dataset.drive === settings.driveType;
    button.setAttribute("aria-checked", String(selected));
    button.classList.toggle("bg-amber-600", selected);
    button.classList.toggle("text-white", selected);
    button.classList.toggle("text-stone-600", !selected);
    button.classList.toggle("dark:text-stone-300", !selected);
  }
}

// ─── Graphs ─────────────────────────────────────────────────────────────────

const darkMode = window.matchMedia("(prefers-color-scheme: dark)");

function palette() {
  const dark = darkMode.matches;
  return {
    grid: dark ? "#292524" : "#e7e5e4",
    axis: dark ? "#57534e" : "#a8a29e",
    text: dark ? "#a8a29e" : "#78716c",
    line: "#d97706",
    faint: dark ? "rgba(168,162,158,0.35)" : "rgba(120,113,108,0.25)",
    wave: dark ? "#78716c" : "#a8a29e",
    played: "#d97706",
  };
}

/// Sizes the canvas to its CSS box at the screen's pixel density and returns
/// a context drawing in CSS pixels.
function surface(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const g = canvas.getContext("2d");
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  g.clearRect(0, 0, width, height);
  g.font = "10px ui-monospace, monospace";
  return { g, width, height };
}

let waveformPeaks = null;

function drawWaveform() {
  if (!take) return;
  const { g, width, height } = surface($("waveform"));
  const colors = palette();
  const columns = Math.max(1, Math.floor(width));
  if (waveformPeaks?.length !== columns) {
    const data = take.getChannelData(0);
    waveformPeaks = new Float32Array(columns);
    const per = data.length / columns;
    for (let x = 0; x < columns; x++) {
      let peak = 0;
      const end = Math.min(data.length, Math.floor((x + 1) * per));
      for (let i = Math.floor(x * per); i < end; i++) peak = Math.max(peak, Math.abs(data[i]));
      waveformPeaks[x] = peak / TAKE_PEAK;
    }
  }
  const playedTo = (position() / take.duration) * width;
  for (let x = 0; x < columns; x++) {
    const h = Math.max(1, waveformPeaks[x] * (height - 8));
    g.fillStyle = x < playedTo ? colors.played : colors.wave;
    g.fillRect(x, (height - h) / 2, 1, h);
  }
  g.fillStyle = colors.line;
  g.fillRect(Math.min(width - 2, playedTo), 0, 2, height);
}

/// Shared frame for the square input/output graphs (both axes in [-1, 1]
/// for the drive, in dB for the compressor).
function squareFrame(g, width, height, colors) {
  const pad = 22;
  const size = Math.min(width - 2 * pad, height - pad - 6);
  const left = (width - size) / 2;
  const top = 6;
  g.strokeStyle = colors.grid;
  g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const p = (i / 4) * size;
    g.beginPath();
    g.moveTo(left + p, top);
    g.lineTo(left + p, top + size);
    g.moveTo(left, top + p);
    g.lineTo(left + size, top + p);
    g.stroke();
  }
  g.strokeStyle = colors.faint;
  g.setLineDash([4, 4]);
  g.beginPath();
  g.moveTo(left, top + size);
  g.lineTo(left + size, top);
  g.stroke();
  g.setLineDash([]);
  return { left, top, size };
}

function drawDriveGraph() {
  const { g, width, height } = surface($("drive-graph"));
  const colors = palette();
  const { left, top, size } = squareFrame(g, width, height, colors);
  const { curve } = driveCurve(settings.driveType, settings.driveAmount);
  g.strokeStyle = settings.driveOn ? colors.line : colors.axis;
  g.lineWidth = 2;
  g.beginPath();
  for (let i = 0; i < curve.length; i += 8) {
    const x = left + (i / (curve.length - 1)) * size;
    const y = top + ((1 - curve[i]) / 2) * size;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
  g.fillStyle = colors.text;
  g.textAlign = "center";
  g.fillText("input →", left + size / 2, top + size + 14);
  g.save();
  g.translate(left - 8, top + size / 2);
  g.rotate(-Math.PI / 2);
  g.fillText("output →", 0, 0);
  g.restore();
}

/// The compressor's static curve, following the Web Audio spec's soft knee.
function compressed(db) {
  const t = settings.compThreshold;
  const r = settings.compRatio;
  const k = COMP_KNEE_DB;
  if (db <= t - k / 2) return db;
  if (db >= t + k / 2) return t + (db - t) / r;
  return db + ((1 / r - 1) * (db - t + k / 2) ** 2) / (2 * k);
}

function drawCompGraph() {
  const { g, width, height } = surface($("comp-graph"));
  const colors = palette();
  const { left, top, size } = squareFrame(g, width, height, colors);
  const minDb = -60;
  const toX = (db) => left + ((db - minDb) / -minDb) * size;
  const toY = (db) => top + (db / minDb) * size;
  g.strokeStyle = settings.compOn ? colors.line : colors.axis;
  g.lineWidth = 2;
  g.beginPath();
  for (let db = minDb; db <= 0; db += 0.5) {
    const y = Math.max(top, Math.min(top + size, toY(compressed(db))));
    if (db === minDb) g.moveTo(toX(db), y);
    else g.lineTo(toX(db), y);
  }
  g.stroke();
  g.fillStyle = colors.text;
  g.textAlign = "center";
  g.fillText(`input (dB) · threshold ${settings.compThreshold}`, left + size / 2, top + size + 14);
  g.textAlign = "left";
  g.fillText("0", left + size + 3, top + 8);
  g.fillText("−60", left + size + 3, top + size);
}

/// The EQ's frequency response, over the live spectrum when `live`.
function drawEq(live = false) {
  const { g, width, height } = surface($("eq-graph"));
  const colors = palette();
  const left = 30;
  const right = width - 6;
  const top = 6;
  const bottom = height - 16;
  const span = Math.log(GRAPH_MAX_HZ / GRAPH_MIN_HZ);
  const toX = (hz) => left + (Math.log(hz / GRAPH_MIN_HZ) / span) * (right - left);
  const toY = (db) => top + ((GRAPH_DB - db) / (2 * GRAPH_DB)) * (bottom - top);

  g.lineWidth = 1;
  g.fillStyle = colors.text;
  g.textAlign = "center";
  for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    g.strokeStyle = colors.grid;
    g.beginPath();
    g.moveTo(toX(hz), top);
    g.lineTo(toX(hz), bottom);
    g.stroke();
    g.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), toX(hz), height - 4);
  }
  g.textAlign = "right";
  for (const db of [-12, -6, 0, 6, 12]) {
    g.strokeStyle = db === 0 ? colors.axis : colors.grid;
    g.beginPath();
    g.moveTo(left, toY(db));
    g.lineTo(right, toY(db));
    g.stroke();
    g.fillText(`${db > 0 ? "+" : ""}${db}`, left - 4, toY(db) + 3);
  }

  const points = Math.max(2, Math.floor(right - left));
  const frequencies = new Float32Array(points);
  for (let i = 0; i < points; i++) frequencies[i] = GRAPH_MIN_HZ * Math.exp((i / (points - 1)) * span);

  if (live && analyser) {
    const bins = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(bins);
    const binHz = audioContext.sampleRate / analyser.fftSize;
    // The spectrum is drawn from −90 dB (bottom) to −10 dB (top).
    g.fillStyle = colors.faint;
    g.beginPath();
    g.moveTo(left, bottom);
    for (let i = 0; i < points; i++) {
      const db = bins[Math.min(bins.length - 1, Math.round(frequencies[i] / binHz))];
      const level = Math.max(0, Math.min(1, (db + 90) / 80));
      g.lineTo(left + i, bottom - level * (bottom - top));
    }
    g.lineTo(right, bottom);
    g.closePath();
    g.fill();
  }

  // The response is computed from the settings (not the live nodes) so the
  // graph shows the target curve even before audio starts.
  const response = new Float32Array(points).fill(0);
  const probe = eqProbe();
  const magnitude = new Float32Array(points);
  const phase = new Float32Array(points);
  for (const filter of probe) {
    filter.getFrequencyResponse(frequencies, magnitude, phase);
    for (let i = 0; i < points; i++) response[i] += 20 * Math.log10(magnitude[i]);
  }
  g.strokeStyle = colors.line;
  g.lineWidth = 2;
  g.beginPath();
  for (let i = 0; i < points; i++) {
    const y = Math.max(top, Math.min(bottom, toY(response[i])));
    if (i === 0) g.moveTo(left + i, y);
    else g.lineTo(left + i, y);
  }
  g.stroke();
}

/// Filters on a silent context set straight to the current EQ settings, only
/// for computing the response curve.
let probeContext = null;
let probeFilters = null;

function eqProbe() {
  if (!probeFilters) {
    probeContext = new OfflineAudioContext(1, 128, 48000);
    probeFilters = ["lowshelf", "peaking", "highshelf"].map((type) => {
      const filter = probeContext.createBiquadFilter();
      filter.type = type;
      return filter;
    });
  }
  const [bass, mid, treble] = probeFilters;
  bass.frequency.value = BASS_HZ;
  bass.gain.value = settings.bass;
  mid.frequency.value = settings.midFreq;
  mid.Q.value = MID_Q;
  mid.gain.value = settings.mid;
  treble.frequency.value = TREBLE_HZ;
  treble.gain.value = settings.treble;
  return probeFilters;
}

function drawStatic() {
  drawCompGraph();
  drawDriveGraph();
  if (!playback.source) drawEq(false);
}

function redrawAll() {
  waveformPeaks = null;
  drawWaveform();
  drawStatic();
}

window.addEventListener("resize", redrawAll);
darkMode.addEventListener("change", redrawAll);

syncControls();
drawStatic();
