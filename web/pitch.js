// Pitch detection for the tuner: YIN on a decimated signal, plus the tunings
// a bass is commonly set to. No DOM here, so the tests can import it directly.

const SHARP_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const FLAT_NAMES = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];

/// A string tuned to `midi`, named with sharps or flats.
function openString(midi, flats = false) {
  const { name, octave } = noteName(midi, flats);
  return { name, note: `${name}${octave}`, midi, frequency: midiToFrequency(midi) };
}

function tuning(id, label, midis, flats = false) {
  return { id, label, strings: midis.map((midi) => openString(midi, flats)) };
}

/// Tunings offered by the tuner, open strings lowest first (MIDI note numbers).
export const TUNINGS = [
  tuning("standard", "Standard (E A D G)", [28, 33, 38, 43]),
  tuning("drop-d", "Drop D (D A D G)", [26, 33, 38, 43]),
  tuning("half-down", "Half step down (E♭ A♭ D♭ G♭)", [27, 32, 37, 42], true),
  tuning("d-standard", "D standard (D G C F)", [26, 31, 36, 41]),
  tuning("drop-c", "Drop C (C G C F)", [24, 31, 36, 41]),
  tuning("five-string", "5 strings (B E A D G)", [23, 28, 33, 38, 43]),
  tuning("five-string-high-c", "5 strings, high C (E A D G C)", [28, 33, 38, 43, 48]),
  tuning("six-string", "6 strings (B E A D G C)", [23, 28, 33, 38, 43, 48]),
];

/// Open strings of a standard-tuned four-string bass.
export const STANDARD_STRINGS = TUNINGS[0].strings;

/// Lowest and highest fundamentals the detector looks for (Hz): below a low B
/// (30.9 Hz) and above the 20th fret of the G string, with margin.
const MIN_FREQUENCY = 28;
const MAX_FREQUENCY = 400;
/// The bass harmonics that matter sit far below this, so the signal is
/// decimated to about this rate to make the search cheap.
const TARGET_RATE = 12000;
/// Samples (after decimation) compared at each lag: about 85 ms, two periods
/// of the low E.
const WINDOW = 1024;
/// YIN's absolute threshold on the normalized difference.
const THRESHOLD = 0.15;
/// Above this the frame is noise, not a note.
const MAX_APERIODICITY = 0.35;
/// Quieter frames (RMS, full scale = 1) are treated as silence.
const MIN_RMS = 0.002;

export function midiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function centsBetween(frequency, reference) {
  return 1200 * Math.log2(frequency / reference);
}

/// Name and octave of a MIDI note in scientific pitch notation (C4 = 60).
export function noteName(midi, flats = false) {
  const pitchClass = ((midi % 12) + 12) % 12;
  return { name: (flats ? FLAT_NAMES : SHARP_NAMES)[pitchClass], octave: Math.floor(midi / 12) - 1 };
}

/// The equal-tempered note closest to `frequency` (A4 = 440 Hz) and how far
/// it is from it, in cents.
export function nearestNote(frequency) {
  const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
  const target = midiToFrequency(midi);
  return { midi, ...noteName(midi), frequency: target, cents: centsBetween(frequency, target) };
}

/// The string closest to `frequency` (in cents) and how far it is from it.
export function nearestString(frequency, strings = STANDARD_STRINGS) {
  let best = null;
  for (const string of strings) {
    const cents = centsBetween(frequency, string.frequency);
    if (!best || Math.abs(cents) < Math.abs(best.cents)) best = { string, cents };
  }
  return best;
}

/// Samples needed for one detection at `sampleRate`.
export function frameLength(sampleRate) {
  const factor = decimationFactor(sampleRate);
  return (WINDOW + Math.ceil(sampleRate / factor / MIN_FREQUENCY) + 2) * factor;
}

function decimationFactor(sampleRate) {
  return Math.max(1, Math.floor(sampleRate / TARGET_RATE));
}

/// Fundamental frequency of the most recent `frameLength(sampleRate)` samples,
/// or null when the frame is silent or not pitched.
///
/// YIN picks the first lag whose normalized difference dips under the
/// threshold, so a strong 2nd harmonic (common on the low strings, whose
/// fundamental small speakers and pickups barely carry) does not make it
/// report the note an octave up.
export function detectPitch(samples, sampleRate) {
  const factor = decimationFactor(sampleRate);
  const rate = sampleRate / factor;
  const minLag = Math.floor(rate / MAX_FREQUENCY);
  const maxLag = Math.ceil(rate / MIN_FREQUENCY);
  const needed = (WINDOW + maxLag + 2) * factor;
  if (samples.length < needed) return null;

  // Box-filter decimation of the latest samples. The caller low-passes the
  // signal first; the box filter only has to keep the rest from aliasing.
  const start = samples.length - needed;
  const x = new Float32Array(WINDOW + maxLag + 2);
  let energy = 0;
  for (let i = 0; i < x.length; i++) {
    let sum = 0;
    for (let k = 0; k < factor; k++) sum += samples[start + i * factor + k];
    x[i] = sum / factor;
    energy += x[i] * x[i];
  }
  const rms = Math.sqrt(energy / x.length);
  if (rms < MIN_RMS) return null;

  // Cumulative mean normalized difference, d'(lag).
  const normalized = new Float32Array(maxLag + 2);
  normalized[0] = 1;
  let runningSum = 0;
  for (let lag = 1; lag < normalized.length; lag++) {
    let difference = 0;
    for (let j = 0; j < WINDOW; j++) {
      const delta = x[j] - x[j + lag];
      difference += delta * delta;
    }
    runningSum += difference;
    normalized[lag] = runningSum > 0 ? (difference * lag) / runningSum : 1;
  }

  let lag = -1;
  for (let candidate = minLag; candidate <= maxLag; candidate++) {
    if (normalized[candidate] < THRESHOLD) {
      while (candidate + 1 <= maxLag && normalized[candidate + 1] < normalized[candidate]) candidate++;
      lag = candidate;
      break;
    }
  }
  if (lag < 0) {
    // No clear dip: fall back to the deepest one, if it is periodic enough.
    lag = minLag;
    for (let candidate = minLag + 1; candidate <= maxLag; candidate++) {
      if (normalized[candidate] < normalized[lag]) lag = candidate;
    }
  }
  const aperiodicity = normalized[lag];
  if (aperiodicity > MAX_APERIODICITY) return null;

  // Parabolic interpolation around the dip for sub-sample precision.
  const before = normalized[lag - 1];
  const after = normalized[lag + 1];
  const curvature = before - 2 * aperiodicity + after;
  const shift = curvature > 0 ? (0.5 * (before - after)) / curvature : 0;
  return { frequency: rate / (lag + shift), clarity: 1 - aperiodicity, rms };
}
