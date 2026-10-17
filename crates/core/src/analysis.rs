//! Global analysis of a transcription: tuning reference and tempo grid.

use crate::model::{Posteriorgram, CONTOUR_BINS_PER_SEMITONE, MIDI_OFFSET};
use crate::notes::Note;

/// How far the recording is from A4 = 440 Hz.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TuningEstimate {
    /// Deviation from equal temperament at A4 = 440 Hz, in cents.
    pub cents: f64,
    /// Number of frames that contributed to the estimate.
    pub frames: usize,
}

impl TuningEstimate {
    /// Frequency of A4 implied by the deviation.
    pub fn reference_a4_hz(&self) -> f64 {
        440.0 * 2f64.powf(self.cents / 1200.0)
    }
}

/// Beat grid used to quantize notes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tempo {
    pub bpm: f64,
    /// Time of a beat at or before the first note, in seconds.
    pub origin: f64,
}

impl Tempo {
    pub fn beat_seconds(&self) -> f64 {
        60.0 / self.bpm
    }
}

const CENTS_PER_CONTOUR_BIN: f64 = 100.0 / CONTOUR_BINS_PER_SEMITONE as f64;
/// Envelope sample rate used for tempo estimation.
const ENVELOPE_RATE: f64 = 200.0;
const MIN_BPM: f64 = 60.0;
const MAX_BPM: f64 = 200.0;
/// Center of the log-normal tempo prior (same idea as librosa's beat tracker).
const PRIOR_BPM: f64 = 120.0;
/// Width of the tempo prior, in octaves.
const PRIOR_OCTAVES: f64 = 1.0;
/// Width of the "close to a beat" window when choosing the grid phase.
const PHASE_SIGMA_S: f64 = 0.03;
/// Fraction of a beat a first note may come before its beat and still start the grid there.
const FIRST_BEAT_TOLERANCE: f64 = 0.25;
/// The grid fit works on sixteenth notes.
const STEPS_PER_BEAT: f64 = 4.0;
/// Notes further than this from the grid (fraction of a sixteenth) are ignored by the fit.
const GRID_FIT_MAX_RESIDUAL: f64 = 0.35;
/// Notes needed before the grid fit starts adjusting the tempo.
const GRID_FIT_MIN_NOTES: usize = 8;
/// The fit may change the tempo by at most this fraction.
const GRID_FIT_MAX_TEMPO_CHANGE: f64 = 0.08;
/// Global refits after the tracking pass.
const GRID_FIT_GLOBAL_PASSES: usize = 3;

/// Estimates the tuning deviation from the fine-grained pitch contour.
///
/// For every frame of every note, the contour peak near the note's nominal
/// bin is refined with parabolic interpolation; the weighted mean of the
/// offsets is the estimate. Resolution is limited (3 bins per semitone), so
/// treat the result as a hint within ~10 cents.
pub fn estimate_tuning(posteriorgram: &Posteriorgram, notes: &[Note]) -> Option<TuningEstimate> {
    let contours = &posteriorgram.contours;
    let mut weighted_sum = 0.0;
    let mut weight_total = 0.0;
    let mut frames = 0;

    for note in notes {
        // Each semitone spans 3 contour bins; its in-tune center is the middle one.
        let center = usize::from(note.pitch - MIDI_OFFSET) * CONTOUR_BINS_PER_SEMITONE + CONTOUR_BINS_PER_SEMITONE / 2;
        if center < 2 || center + 2 >= contours.cols() {
            continue;
        }
        for frame in note.start_frame..note.end_frame.min(contours.rows()) {
            let peak = (center - 2..=center + 2)
                .max_by(|a, b| contours.get(frame, *a).total_cmp(&contours.get(frame, *b)))
                .expect("non-empty range");
            let (left, middle, right) =
                (contours.get(frame, peak - 1), contours.get(frame, peak), contours.get(frame, peak + 1));
            let curvature = left - 2.0 * middle + right;
            if middle < 0.1 || curvature >= 0.0 {
                continue;
            }
            let refined = peak as f64 + f64::from(0.5 * (left - right) / curvature);
            let offset_cents = (refined - center as f64) * CENTS_PER_CONTOUR_BIN;
            if offset_cents.abs() > 50.0 {
                continue;
            }
            weighted_sum += offset_cents * f64::from(middle);
            weight_total += f64::from(middle);
            frames += 1;
        }
    }

    (weight_total > 0.0).then(|| TuningEstimate { cents: weighted_sum / weight_total, frames })
}

fn onset_envelope(notes: &[Note]) -> Vec<f64> {
    let duration = notes.iter().map(|n| n.start).fold(0.0, f64::max) + 1.0;
    let mut envelope = vec![0.0; (duration * ENVELOPE_RATE) as usize + 1];
    for note in notes {
        envelope[(note.start * ENVELOPE_RATE).round() as usize] += f64::from(note.amplitude);
    }
    // Light Gaussian smoothing (sigma = 2 samples = 10 ms) to tolerate timing jitter.
    let kernel: Vec<f64> = (-6i32..=6).map(|k| (-(f64::from(k).powi(2)) / 8.0).exp()).collect();
    (0..envelope.len())
        .map(|i| {
            kernel
                .iter()
                .enumerate()
                .filter_map(|(k, w)| (i + k).checked_sub(6).and_then(|j| envelope.get(j)).map(|v| v * w))
                .sum()
        })
        .collect()
}

fn estimate_bpm(envelope: &[f64]) -> Option<f64> {
    let min_lag = (60.0 / MAX_BPM * ENVELOPE_RATE).floor() as usize;
    let max_lag = (60.0 / MIN_BPM * ENVELOPE_RATE).ceil() as usize;
    if envelope.len() <= max_lag {
        return None;
    }
    let scores: Vec<f64> = (min_lag..=max_lag)
        .map(|lag| {
            let autocorrelation: f64 = envelope.iter().zip(&envelope[lag..]).map(|(a, b)| a * b).sum();
            let bpm = 60.0 * ENVELOPE_RATE / lag as f64;
            let prior = (-0.5 * ((bpm / PRIOR_BPM).log2() / PRIOR_OCTAVES).powi(2)).exp();
            autocorrelation * prior
        })
        .collect();
    let best = scores.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1))?.0;
    if scores[best] <= 0.0 {
        return None;
    }
    // Parabolic refinement of the best lag.
    let refined = if best > 0 && best + 1 < scores.len() {
        let (l, m, r) = (scores[best - 1], scores[best], scores[best + 1]);
        let curvature = l - 2.0 * m + r;
        if curvature < 0.0 {
            best as f64 + 0.5 * (l - r) / curvature
        } else {
            best as f64
        }
    } else {
        best as f64
    };
    Some(60.0 * ENVELOPE_RATE / (min_lag as f64 + refined))
}

fn best_phase(notes: &[Note], beat: f64) -> f64 {
    let steps = 500;
    (0..steps)
        .map(|step| beat * step as f64 / steps as f64)
        .max_by(|a, b| phase_score(notes, beat, *a).total_cmp(&phase_score(notes, beat, *b)))
        .unwrap_or(0.0)
}

fn phase_score(notes: &[Note], beat: f64, phase: f64) -> f64 {
    notes
        .iter()
        .map(|note| {
            let position = (note.start - phase) / beat;
            let distance = (position - position.round()) * beat;
            f64::from(note.amplitude) * (-0.5 * (distance / PHASE_SIGMA_S).powi(2)).exp()
        })
        .sum()
}

/// Refines tempo and origin by following the sixteenth-note grid through the
/// song and fitting `time = origin + index * step` with weighted least
/// squares. A small tempo error otherwise accumulates into notes drifting
/// off the grid in later bars.
fn refine_grid(notes: &[Note], tempo: Tempo) -> Tempo {
    let initial_step = tempo.beat_seconds() / STEPS_PER_BEAT;
    let accept = |fitted_step: f64| (fitted_step / initial_step - 1.0).abs() < GRID_FIT_MAX_TEMPO_CHANGE;
    let (mut step, mut origin) = (initial_step, tempo.origin);

    // Pass 1: follow the grid note by note so a small initial error cannot
    // accumulate into whole-step index mistakes later in the song.
    let mut fit = GridFit::default();
    for note in notes {
        if fit.add(note, step, origin) && fit.count >= GRID_FIT_MIN_NOTES {
            if let Some((fitted_step, fitted_origin)) = fit.solve().filter(|(s, _)| accept(*s)) {
                (step, origin) = (fitted_step, fitted_origin);
            }
        }
    }
    // Pass 2: re-index every note with the tracked grid and refit globally,
    // which removes index mistakes made while the tracker was converging.
    for _ in 0..GRID_FIT_GLOBAL_PASSES {
        let mut fit = GridFit::default();
        for note in notes {
            fit.add(note, step, origin);
        }
        if let Some((fitted_step, fitted_origin)) = fit.solve().filter(|(s, _)| accept(*s)) {
            (step, origin) = (fitted_step, fitted_origin);
        }
    }
    Tempo { bpm: 60.0 / (step * STEPS_PER_BEAT), origin }
}

/// Running weighted least-squares fit of `time = origin + index * step`.
#[derive(Default)]
struct GridFit {
    sw: f64,
    sx: f64,
    sy: f64,
    sxx: f64,
    sxy: f64,
    count: usize,
}

impl GridFit {
    /// Adds a note if it is close enough to the current grid; returns whether it was used.
    fn add(&mut self, note: &Note, step: f64, origin: f64) -> bool {
        let index = ((note.start - origin) / step).round();
        let residual = (note.start - origin - index * step) / step;
        if residual.abs() > GRID_FIT_MAX_RESIDUAL {
            return false;
        }
        let weight = f64::from(note.amplitude);
        self.sw += weight;
        self.sx += weight * index;
        self.sy += weight * note.start;
        self.sxx += weight * index * index;
        self.sxy += weight * index * note.start;
        self.count += 1;
        true
    }

    /// Returns `(step, origin)`, or `None` if the notes do not determine a line.
    fn solve(&self) -> Option<(f64, f64)> {
        let denominator = self.sw * self.sxx - self.sx * self.sx;
        if denominator <= 1e-9 {
            return None;
        }
        let step = (self.sw * self.sxy - self.sx * self.sy) / denominator;
        Some((step, (self.sy - step * self.sx) / self.sw))
    }
}

/// Estimates the tempo and beat phase from note onsets. `bpm_override`
/// skips the tempo estimate but still aligns the grid to the notes.
pub fn estimate_tempo(notes: &[Note], bpm_override: Option<f64>) -> Tempo {
    let bpm = bpm_override.or_else(|| estimate_bpm(&onset_envelope(notes))).unwrap_or(PRIOR_BPM);
    let tempo = Tempo { bpm, origin: first_beat(notes, 60.0 / bpm) };
    if bpm_override.is_some() {
        return tempo;
    }
    let refined = refine_grid(notes, tempo);
    // The fit pins the sixteenth grid precisely, but its index 0 can slip by a
    // whole step; move it back onto the beat chosen from the accents.
    let step = refined.beat_seconds() / STEPS_PER_BEAT;
    let beat_origin = first_beat(notes, refined.beat_seconds());
    let shift = ((beat_origin - refined.origin) / step).round();
    Tempo { bpm: refined.bpm, origin: refined.origin + shift * step }
}

/// The beat (according to the accent pattern) at or just before the first note.
fn first_beat(notes: &[Note], beat: f64) -> f64 {
    let phase = best_phase(notes, beat);
    let first_start = notes.first().map(|n| n.start).unwrap_or(0.0);
    // The tolerance keeps a first note played slightly early on its beat.
    let beats_before = ((first_start - phase) / beat + FIRST_BEAT_TOLERANCE).floor();
    phase + beats_before * beat
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note_at(start: f64) -> Note {
        Note { start, end: start + 0.1, start_frame: 0, end_frame: 0, pitch: 28, amplitude: 0.8 }
    }

    #[test]
    fn finds_tempo_of_regular_eighth_notes() {
        // Eighth notes at 100 BPM starting at 0.37 s, accented on the beat.
        let notes: Vec<Note> = (0..64)
            .map(|i| Note { amplitude: if i % 2 == 0 { 0.9 } else { 0.4 }, ..note_at(0.37 + i as f64 * 0.3) })
            .collect();
        let tempo = estimate_tempo(&notes, None);
        assert!((tempo.bpm - 100.0).abs() < 1.5, "bpm was {}", tempo.bpm);
        assert!((tempo.origin - 0.37).abs() < 0.02, "origin was {} (bpm {})", tempo.origin, tempo.bpm);
    }

    #[test]
    fn grid_fit_removes_tempo_drift() {
        // A riff of quarters and eighths at 97 BPM, starting from a 2% wrong guess.
        let beat = 60.0 / 97.0;
        let pattern = [0.0, 1.0, 1.5, 2.0, 3.0, 3.5];
        let notes: Vec<Note> =
            (0..24).flat_map(|bar| pattern.iter().map(move |b| note_at(0.5 + (bar as f64 * 4.0 + b) * beat))).collect();
        let refined = refine_grid(&notes, Tempo { bpm: 97.0 * 1.02, origin: 0.5 });
        assert!((refined.bpm - 97.0).abs() < 0.05, "bpm was {}", refined.bpm);
        // The fitted origin lies on the sixteenth grid (not necessarily on the beat).
        let step = beat / 4.0;
        let steps_off = (refined.origin - 0.5) / step;
        assert!((steps_off - steps_off.round()).abs() * step < 0.005, "origin was {}", refined.origin);

        let tempo = estimate_tempo(&notes, None);
        assert!((tempo.bpm - 97.0).abs() < 0.05, "bpm was {}", tempo.bpm);
        assert!((tempo.origin - 0.5).abs() < 0.005, "origin was {}", tempo.origin);
    }

    #[test]
    fn honours_a_tempo_override() {
        let notes: Vec<Note> = (0..16).map(|i| note_at(1.0 + i as f64 * 0.5)).collect();
        let tempo = estimate_tempo(&notes, Some(120.0));
        assert_eq!(tempo.bpm, 120.0);
        assert!((tempo.origin - 1.0).abs() < 0.02 || tempo.origin < 1.0);
    }
}
