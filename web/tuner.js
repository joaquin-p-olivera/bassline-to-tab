// Bass tuner page: reference notes played with Web Audio, and pitch detection
// from the microphone (see pitch.js), either against the strings of the chosen
// tuning or against any note.

import { openInput, setupInputSelect } from "./audio-input.js";
import { TUNINGS, detectPitch, frameLength, nearestNote, nearestString } from "./pitch.js";

/// Within this many cents the string counts as in tune.
const IN_TUNE_CENTS = 5;
/// The needle's range, each side of the center.
const METER_RANGE_CENTS = 50;
/// Readings in the median that steadies the display.
const SMOOTHING_READINGS = 7;
/// A reading this far from the current median starts over (a new string).
const NEW_NOTE_CENTS = 70;
/// How long the last reading stays on screen after the string stops ringing.
const HOLD_MS = 1500;
const REFERENCE_SECONDS = 4;
/// Harmonic amplitudes of the reference note. The fundamental of the low
/// strings (41 Hz for E) is below what phone and laptop speakers can play, so
/// the upper harmonics carry the pitch there, as they do on a real bass.
const REFERENCE_HARMONICS = [0, 1, 0.8, 0.55, 0.4, 0.3, 0.2, 0.14, 0.1];
const TUNING_KEY = "tuner.tuning";
const MODE_KEY = "tuner.mode";

const $ = (id) => document.getElementById(id);

/// Uses both Tailwind's class and the native attribute, so visibility works
/// even if the Tailwind CDN fails to load.
function show(element, visible) {
  element.classList.toggle("hidden", !visible);
  element.hidden = !visible;
}

for (const element of document.querySelectorAll(".hidden")) element.hidden = true;

let audioContext = null;
/// The open microphone, while listening.
let listening = null;

function context() {
  audioContext ??= new AudioContext();
  // Browsers start the context suspended until a user gesture.
  if (audioContext.state === "suspended") audioContext.resume();
  return audioContext;
}

/// Remembered choices are a convenience: storage may be blocked or missing.
function remembered(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered; the page works the same.
  }
}

// ─── Tuning ─────────────────────────────────────────────────────────────────

let tuning = TUNINGS.find((t) => t.id === remembered(TUNING_KEY)) ?? TUNINGS[0];

for (const option of TUNINGS) {
  $("tuning").append(new Option(option.label, option.id, false, option === tuning));
}

$("tuning").addEventListener("change", (event) => {
  tuning = TUNINGS.find((t) => t.id === event.target.value) ?? TUNINGS[0];
  remember(TUNING_KEY, tuning.id);
  stopReference();
  renderStrings();
  resetReadings();
});

// ─── Reference notes ────────────────────────────────────────────────────────

/// Buttons by string index (a tuning such as Drop D has two strings named D).
let stringButtons = [];
let reference = null;

function renderStrings() {
  const container = $("strings");
  container.replaceChildren();
  container.style.gridTemplateColumns = `repeat(${tuning.strings.length}, minmax(0, 1fr))`;
  const compact = tuning.strings.length > 4;
  stringButtons = tuning.strings.map((string, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.string = string.name;
    button.setAttribute("aria-pressed", "false");
    button.title = `Play ${string.note} (${string.frequency.toFixed(1)} Hz)`;
    button.className = `string-button rounded-lg border border-stone-300 ${compact ? "px-1" : "px-2"} py-4 transition hover:border-amber-500 dark:border-stone-700`;
    button.innerHTML = `<span class="block ${compact ? "text-2xl" : "text-3xl"} font-bold">${string.name}</span>
      <span class="block font-mono text-xs text-stone-500">${string.note}</span>
      <span class="block whitespace-nowrap font-mono text-xs text-stone-500">${string.frequency.toFixed(compact ? 0 : 1)} Hz</span>`;
    button.addEventListener("click", () => playReference(string, index));
    container.append(button);
    return button;
  });
}

renderStrings();

function playReference(string, index) {
  const ctx = context();
  stopReference();
  const real = new Float32Array(REFERENCE_HARMONICS.length);
  const wave = ctx.createPeriodicWave(real, Float32Array.from(REFERENCE_HARMONICS));
  const oscillator = new OscillatorNode(ctx, { frequency: string.frequency, periodicWave: wave });
  const gain = new GainNode(ctx, { gain: 0 });
  const now = ctx.currentTime;
  // Pluck: a fast attack, then a long decay, like a string left ringing.
  gain.gain.linearRampToValueAtTime(0.35, now + 0.01);
  gain.gain.setTargetAtTime(0, now + 0.01, REFERENCE_SECONDS / 4);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(now);
  oscillator.stop(now + REFERENCE_SECONDS);
  reference = { oscillator, gain, string };
  setPlaying(index);
  oscillator.onended = () => {
    if (reference?.oscillator === oscillator) {
      reference = null;
      setPlaying(-1);
    }
  };
}

function stopReference() {
  if (!reference) return;
  const { oscillator, gain } = reference;
  const now = audioContext.currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setTargetAtTime(0, now, 0.01);
  oscillator.stop(now + 0.05);
  reference = null;
  setPlaying(-1);
}

function setPlaying(playingIndex) {
  for (const [index, button] of stringButtons.entries()) {
    const playing = index === playingIndex;
    button.setAttribute("aria-pressed", String(playing));
    button.classList.toggle("bg-amber-100", playing);
    button.classList.toggle("dark:bg-amber-950", playing);
  }
}

// ─── Mode ───────────────────────────────────────────────────────────────────

/// "tune": compare with the open strings of the tuning. "note": name whatever
/// note is playing, fretted or open.
let mode = remembered(MODE_KEY) === "note" ? "note" : "tune";

const MODE_HELP = {
  tune: "Play one open string at a time and let it ring.",
  note: "Play any note, open or fretted, and see which one it is.",
};

for (const button of document.querySelectorAll(".mode-button")) {
  button.addEventListener("click", () => setMode(button.dataset.mode));
}

function setMode(next) {
  mode = next;
  remember(MODE_KEY, mode);
  for (const button of document.querySelectorAll(".mode-button")) {
    const selected = button.dataset.mode === mode;
    button.setAttribute("aria-checked", String(selected));
    button.classList.toggle("bg-amber-600", selected);
    button.classList.toggle("text-white", selected);
    button.classList.toggle("text-stone-600", !selected);
    button.classList.toggle("dark:text-stone-300", !selected);
  }
  $("mode-help").textContent = MODE_HELP[mode];
  resetReadings();
}

setMode(mode);

// ─── Microphone ─────────────────────────────────────────────────────────────

$("listen").addEventListener("click", () => (listening ? stopListening() : startListening()));
setupInputSelect($("audio-input"));
// Switching inputs while listening reopens the stream on the new one.
$("audio-input").addEventListener("change", () => {
  if (!listening) return;
  stopListening();
  startListening();
});

async function startListening() {
  show($("mic-error"), false);
  const ctx = context();
  let stream;
  try {
    let fellBack;
    ({ stream, fellBack } = await openInput($("audio-input")));
    if (fellBack) {
      $("mic-error").textContent = "The chosen input is not connected, so the default input is listening.";
      show($("mic-error"), true);
    }
  } catch (error) {
    const box = $("mic-error");
    box.textContent =
      error.name === "NotAllowedError"
        ? "The microphone is blocked. Allow it for this page in the browser settings and try again."
        : `Could not open the microphone: ${error.message}`;
    show(box, true);
    return;
  }

  const source = ctx.createMediaStreamSource(stream);
  // Keep the bass range: overtones above ~1 kHz only add noise to the search.
  const lowpass = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 1000 });
  const needed = frameLength(ctx.sampleRate);
  const analyser = new AnalyserNode(ctx, { fftSize: 2 ** Math.ceil(Math.log2(needed)) });
  source.connect(lowpass).connect(analyser);

  const samples = new Float32Array(analyser.fftSize);
  const readings = [];
  let lastHeard = 0;
  const reset = () => {
    readings.length = 0;
    showReading(null);
  };
  const tick = () => {
    if (!listening) return;
    analyser.getFloatTimeDomainData(samples);
    const pitch = detectPitch(samples, ctx.sampleRate);
    const now = performance.now();
    if (pitch) {
      lastHeard = now;
      const median = readings.length ? medianOf(readings) : null;
      if (median && Math.abs(1200 * Math.log2(pitch.frequency / median)) > NEW_NOTE_CENTS) readings.length = 0;
      readings.push(pitch.frequency);
      if (readings.length > SMOOTHING_READINGS) readings.shift();
      showReading(medianOf(readings));
    } else if (readings.length && now - lastHeard > HOLD_MS) {
      readings.length = 0;
      showReading(null);
    }
    listening.frame = requestAnimationFrame(tick);
  };

  listening = { stream, source, frame: 0, reset };
  // Unplugging the interface ends the track.
  for (const track of stream.getTracks()) {
    track.addEventListener("ended", () => listening?.stream === stream && stopListening());
  }
  $("listen").textContent = "Stop listening";
  show($("meter"), true);
  showReading(null);
  tick();
}

function stopListening() {
  cancelAnimationFrame(listening.frame);
  for (const track of listening.stream.getTracks()) track.stop();
  listening.source.disconnect();
  listening = null;
  $("listen").textContent = "Start listening";
  show($("meter"), false);
  highlightDetected(-1);
}

/// Drops the current reading, after the tuning or the mode changes.
function resetReadings() {
  if (listening) listening.reset();
}

function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function showReading(frequency) {
  const needle = $("needle");
  if (frequency === null) {
    $("detected-string").textContent = "–";
    $("detected-octave").textContent = "";
    $("cents").textContent = "";
    $("advice").textContent = mode === "note" ? "Play a note" : "Play a string";
    $("frequency").textContent = "";
    needle.style.left = "50%";
    setNeedleColor("bg-stone-400");
    highlightDetected(-1);
    return;
  }
  let cents;
  let inTune;
  if (mode === "note") {
    const note = nearestNote(frequency);
    cents = note.cents;
    inTune = Math.abs(cents) <= IN_TUNE_CENTS;
    $("detected-string").textContent = note.name;
    $("detected-octave").textContent = String(note.octave);
    $("advice").textContent = inTune ? "Right on the note" : cents < 0 ? "A little flat" : "A little sharp";
    $("frequency").textContent =
      `${frequency.toFixed(1)} Hz · ${note.name}${note.octave} is ${note.frequency.toFixed(1)} Hz`;
    highlightDetected(-1);
  } else {
    const nearest = nearestString(frequency, tuning.strings);
    const { string } = nearest;
    cents = nearest.cents;
    inTune = Math.abs(cents) <= IN_TUNE_CENTS;
    $("detected-string").textContent = string.name;
    $("detected-octave").textContent = "";
    $("advice").textContent = inTune
      ? "In tune"
      : cents < 0
        ? "Too low: tighten the string (tune up)"
        : "Too high: loosen the string (tune down)";
    $("frequency").textContent = `${frequency.toFixed(1)} Hz · target ${string.note} ${string.frequency.toFixed(1)} Hz`;
    highlightDetected(tuning.strings.indexOf(string));
  }
  const rounded = Math.round(cents);
  $("cents").textContent = `${rounded > 0 ? "+" : rounded < 0 ? "−" : "±"}${Math.abs(rounded)} ¢`;
  const clamped = Math.max(-METER_RANGE_CENTS, Math.min(METER_RANGE_CENTS, cents));
  needle.style.left = `${50 + (clamped / METER_RANGE_CENTS) * 50}%`;
  setNeedleColor(inTune ? "bg-green-600" : "bg-amber-600");
  $("meter").dataset.cents = cents.toFixed(1);
}

function setNeedleColor(color) {
  const needle = $("needle");
  needle.classList.remove("bg-stone-400", "bg-green-600", "bg-amber-600");
  needle.classList.add(color);
}

function highlightDetected(detectedIndex) {
  for (const [index, button] of stringButtons.entries()) {
    const detected = index === detectedIndex;
    button.classList.toggle("border-amber-500", detected);
    button.classList.toggle("ring-2", detected);
    button.classList.toggle("ring-amber-500", detected);
  }
}
