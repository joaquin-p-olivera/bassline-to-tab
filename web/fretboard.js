// Fretboard page: every fret of a standard-tuned bass with the note it
// plays. Tapping a fret plays it; optionally every fret with the same note is
// highlighted.

import { STANDARD_STRINGS, midiToFrequency, noteName } from "./pitch.js";

/// Inlay dots, as on a real bass; the octave frets get two.
const SINGLE_DOTS = new Set([3, 5, 7, 9, 15, 17, 19, 21]);
const DOUBLE_DOTS = new Set([12, 24]);
/// Thickness of each drawn string, lowest first (E is the thickest).
const GAUGES = { E: "4px", A: "3px", D: "2px", G: "1.5px" };
const NOTE_SECONDS = 2.5;
/// Same harmonic recipe as the tuner's reference notes: small speakers can't
/// play the fundamental of the low frets, so the overtones carry the pitch.
const HARMONICS = [0, 1, 0.8, 0.55, 0.4, 0.3, 0.2, 0.14, 0.1];

const $ = (id) => document.getElementById(id);

const settings = {
  frets: 12,
  flats: false,
  showOctave: false,
  highlight: false,
};
/// Pitch class (0 = C) highlighted across the neck, or null.
let selected = null;

$("fret-count").addEventListener("change", (event) => {
  settings.frets = Number(event.target.value);
  render();
});
$("notation").addEventListener("change", (event) => {
  settings.flats = event.target.value === "flats";
  render();
});
$("show-octave").addEventListener("change", (event) => {
  settings.showOctave = event.target.checked;
  render();
});
$("highlight").addEventListener("change", (event) => {
  settings.highlight = event.target.checked;
  if (!settings.highlight) selected = null;
  render();
});

function render() {
  const neck = $("neck");
  neck.style.setProperty("--frets", settings.frets);
  neck.replaceChildren();

  // Highest string on top, like a tab.
  for (const string of [...STANDARD_STRINGS].reverse()) {
    const label = document.createElement("div");
    label.className = "label bg-white font-bold text-stone-500 dark:bg-stone-900";
    label.textContent = string.name;
    neck.append(label);
    for (let fret = 0; fret <= settings.frets; fret++) {
      neck.append(fretCell(string, fret));
    }
  }

  // Fret numbers, with the inlay dots under them.
  neck.append(document.createElement("div"));
  for (let fret = 0; fret <= settings.frets; fret++) {
    const marker = document.createElement("div");
    marker.className = "marker py-1 font-mono text-xs text-stone-500";
    const dots = DOUBLE_DOTS.has(fret) ? "●●" : SINGLE_DOTS.has(fret) ? "●" : "";
    marker.innerHTML = `<span>${fret}</span><span class="h-4 tracking-widest text-stone-400" aria-hidden="true">${dots}</span>`;
    if (dots) marker.classList.add("bg-stone-100", "dark:bg-stone-800");
    neck.append(marker);
  }

  showSelection();
}

function fretCell(string, fret) {
  const midi = string.midi + fret;
  const cell = document.createElement("div");
  cell.className = `cell ${fret === 0 ? "open" : "fret"}`;
  cell.style.setProperty("--gauge", GAUGES[string.name]);
  if (SINGLE_DOTS.has(fret) || DOUBLE_DOTS.has(fret)) cell.classList.add("bg-stone-50", "dark:bg-stone-800/50");

  const highlighted = selected === midi % 12;
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.string = string.name;
  button.dataset.fret = fret;
  button.dataset.midi = midi;
  // The highlighted colors live in fretboard.html's CSS, keyed on aria-pressed.
  button.className = "note border transition";
  if (!highlighted) {
    button.classList.add("border-stone-300", "bg-white", "hover:border-amber-500", "dark:border-stone-600", "dark:bg-stone-900");
  }
  button.setAttribute("aria-pressed", String(highlighted));
  const { name, octave } = noteName(midi, settings.flats);
  const fretText = fret === 0 ? "open" : `fret ${fret}`;
  button.title = `${string.name} string, ${fretText}: ${name}${octave} (${midiToFrequency(midi).toFixed(1)} Hz)`;
  button.setAttribute("aria-label", button.title);
  button.innerHTML = settings.showOctave
    ? `${name}<sub class="text-[0.65rem] font-normal opacity-70">${octave}</sub>`
    : name;
  button.addEventListener("click", () => tap(midi));
  cell.append(button);
  return cell;
}

function tap(midi) {
  play(midiToFrequency(midi));
  if (!settings.highlight) return;
  selected = selected === midi % 12 ? null : midi % 12;
  render();
}

function showSelection() {
  const box = $("selection");
  const visible = settings.highlight;
  box.classList.toggle("hidden", !visible);
  box.hidden = !visible;
  if (!visible) return;
  if (selected === null) {
    box.textContent = "Tap a fret to see everywhere its note is on the neck.";
    return;
  }
  const count = $("neck").querySelectorAll('[aria-pressed="true"]').length;
  box.textContent = `${noteName(selected, settings.flats).name}: ${count} places on the neck. Tap it again to clear.`;
}

// ─── Sound ──────────────────────────────────────────────────────────────────

let audioContext = null;
let ringing = null;

function play(frequency) {
  audioContext ??= new AudioContext();
  // Browsers start the context suspended until a user gesture.
  if (audioContext.state === "suspended") audioContext.resume();
  const ctx = audioContext;
  const now = ctx.currentTime;
  // One note at a time, like fretting a single string.
  if (ringing) {
    ringing.gain.gain.cancelScheduledValues(now);
    ringing.gain.gain.setTargetAtTime(0, now, 0.01);
    ringing.oscillator.stop(now + 0.05);
  }
  const wave = ctx.createPeriodicWave(new Float32Array(HARMONICS.length), Float32Array.from(HARMONICS));
  const oscillator = new OscillatorNode(ctx, { frequency, periodicWave: wave });
  const gain = new GainNode(ctx, { gain: 0 });
  // Pluck: a fast attack, then a long decay.
  gain.gain.linearRampToValueAtTime(0.35, now + 0.01);
  gain.gain.setTargetAtTime(0, now + 0.01, NOTE_SECONDS / 4);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(now);
  oscillator.stop(now + NOTE_SECONDS);
  ringing = { oscillator, gain };
  oscillator.onended = () => {
    if (ringing?.oscillator === oscillator) ringing = null;
  };
}

render();
