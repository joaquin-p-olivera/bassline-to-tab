// Bass tuner page: reference notes played with Web Audio, and pitch detection
// from the microphone (see pitch.js).

import { STANDARD_STRINGS, detectPitch, frameLength, nearestString } from "./pitch.js";

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

const $ = (id) => document.getElementById(id);

/// Uses both Tailwind's class and the native attribute, so visibility works
/// even if the Tailwind CDN fails to load.
function show(element, visible) {
  element.classList.toggle("hidden", !visible);
  element.hidden = !visible;
}

for (const element of document.querySelectorAll(".hidden")) element.hidden = true;

let audioContext = null;

function context() {
  audioContext ??= new AudioContext();
  // Browsers start the context suspended until a user gesture.
  if (audioContext.state === "suspended") audioContext.resume();
  return audioContext;
}

// ─── Reference notes ────────────────────────────────────────────────────────

const stringButtons = new Map();
let reference = null;

for (const string of STANDARD_STRINGS) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.string = string.name;
  button.setAttribute("aria-pressed", "false");
  button.title = `Play ${string.note} (${string.frequency.toFixed(1)} Hz)`;
  button.className =
    "string-button rounded-lg border border-stone-300 px-2 py-4 transition hover:border-amber-500 dark:border-stone-700";
  button.innerHTML = `<span class="block text-3xl font-bold">${string.name}</span>
    <span class="block font-mono text-xs text-stone-500">${string.note} · ${string.frequency.toFixed(1)} Hz</span>`;
  button.addEventListener("click", () => playReference(string));
  $("strings").append(button);
  stringButtons.set(string.name, button);
}

function playReference(string) {
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
  setPlaying(string.name);
  oscillator.onended = () => {
    if (reference?.oscillator === oscillator) {
      reference = null;
      setPlaying(null);
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
}

function setPlaying(name) {
  for (const [stringName, button] of stringButtons) {
    const playing = stringName === name;
    button.setAttribute("aria-pressed", String(playing));
    button.classList.toggle("bg-amber-100", playing);
    button.classList.toggle("dark:bg-amber-950", playing);
  }
}

// ─── Microphone ─────────────────────────────────────────────────────────────

let listening = null;

$("listen").addEventListener("click", () => (listening ? stopListening() : startListening()));

async function startListening() {
  show($("mic-error"), false);
  const ctx = context();
  let stream;
  try {
    // Echo cancellation, noise suppression and gain control are made for
    // voices: they filter out and pump the low, sustained notes of a bass.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
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

  listening = { stream, source, frame: 0 };
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
  highlightDetected(null);
}

function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function showReading(frequency) {
  const needle = $("needle");
  if (frequency === null) {
    $("detected-string").textContent = "–";
    $("cents").textContent = "";
    $("advice").textContent = "Play a string";
    $("frequency").textContent = "";
    needle.style.left = "50%";
    setNeedleColor("bg-stone-400");
    highlightDetected(null);
    return;
  }
  const { string, cents } = nearestString(frequency);
  const rounded = Math.round(cents);
  const inTune = Math.abs(cents) <= IN_TUNE_CENTS;
  $("detected-string").textContent = string.name;
  $("cents").textContent = `${rounded > 0 ? "+" : rounded < 0 ? "−" : "±"}${Math.abs(rounded)} ¢`;
  $("advice").textContent = inTune
    ? "In tune"
    : cents < 0
      ? "Too low: tighten the string (tune up)"
      : "Too high: loosen the string (tune down)";
  $("frequency").textContent = `${frequency.toFixed(1)} Hz · target ${string.note} ${string.frequency.toFixed(1)} Hz`;
  const clamped = Math.max(-METER_RANGE_CENTS, Math.min(METER_RANGE_CENTS, cents));
  needle.style.left = `${50 + (clamped / METER_RANGE_CENTS) * 50}%`;
  setNeedleColor(inTune ? "bg-green-600" : "bg-amber-600");
  $("meter").dataset.cents = cents.toFixed(1);
  highlightDetected(string.name);
}

function setNeedleColor(color) {
  const needle = $("needle");
  needle.classList.remove("bg-stone-400", "bg-green-600", "bg-amber-600");
  needle.classList.add(color);
}

function highlightDetected(name) {
  for (const [stringName, button] of stringButtons) {
    const detected = stringName === name;
    button.classList.toggle("border-amber-500", detected);
    button.classList.toggle("ring-2", detected);
    button.classList.toggle("ring-amber-500", detected);
  }
}
