//! Turning model posteriorgrams into discrete note events.
//!
//! `decode_notes` follows the onset-tracking approach of Basic Pitch's
//! `output_to_notes_polyphonic` (Spotify, Apache-2.0): peaks in the onset
//! activations start notes, which are extended while the note activation
//! stays above a threshold. Basic Pitch's "melodia trick" (adding notes with
//! no detected onset) is intentionally left out: on bass it mostly adds noise.
//! `to_monophonic` then reduces the result to a single line, or `to_chords`
//! groups it into chords (guitar).

use crate::model::{Grid, Posteriorgram, MIDI_OFFSET, N_PITCHES};

/// A detected note.
#[derive(Clone, Debug, PartialEq)]
pub struct Note {
    pub start: f64,
    pub end: f64,
    pub start_frame: usize,
    pub end_frame: usize,
    pub pitch: u8,
    /// Mean note activation, between 0 and 1.
    pub amplitude: f32,
}

/// Parameters for [`decode_notes`].
#[derive(Clone, Debug)]
pub struct DecodeParams {
    /// Minimum onset activation for a note to start.
    pub onset_threshold: f32,
    /// Minimum note activation for a note to keep sounding.
    pub frame_threshold: f32,
    /// Notes this short (in frames) or shorter are dropped.
    pub min_note_frames: usize,
    /// Frames below `frame_threshold` tolerated before a note ends.
    pub energy_tolerance: usize,
    /// Add onsets where the note activation jumps sharply.
    pub infer_onsets: bool,
    /// Lowest MIDI pitch considered.
    pub min_pitch: u8,
    /// Highest MIDI pitch considered.
    pub max_pitch: u8,
}

impl Default for DecodeParams {
    fn default() -> Self {
        Self {
            onset_threshold: 0.5,
            frame_threshold: 0.3,
            min_note_frames: 7,
            energy_tolerance: 11,
            infer_onsets: true,
            min_pitch: MIDI_OFFSET,
            max_pitch: MIDI_OFFSET + N_PITCHES as u8 - 1,
        }
    }
}

/// Notes starting within this many seconds of each other count as simultaneous.
const SIMULTANEOUS_WINDOW_S: f64 = 0.05;
/// A lower simultaneous note wins unless it is this much weaker than the higher one.
const LOWER_NOTE_MIN_RELATIVE_AMPLITUDE: f32 = 0.5;
/// A note ending this close to a stronger note of the same pitch may be a pre-echo...
const PRE_ECHO_MAX_GAP_S: f64 = 0.025;
/// ...if it is weaker than this fraction of that note.
const PRE_ECHO_MAX_RELATIVE_AMPLITUDE: f32 = 0.5;
/// Chord notes weaker than this fraction of the strongest one are dropped.
const CHORD_NOTE_MIN_RELATIVE_AMPLITUDE: f32 = 0.3;
/// Intervals (semitones) at which the model reports overtones of a lower
/// note: octave, octave + fifth, two octaves.
const OVERTONE_INTERVALS: [u8; 3] = [12, 19, 24];
/// A chord note an overtone interval above another is taken as that note's
/// overtone when it is weaker than this fraction of it. Real octave
/// doublings in a chord are about as loud as the note below.
const OVERTONE_MAX_RELATIVE_AMPLITUDE: f32 = 0.6;
/// A guitar has six strings.
const MAX_CHORD_NOTES: usize = 6;

fn pitch_bin_range(params: &DecodeParams) -> (usize, usize) {
    let low = usize::from(params.min_pitch.max(MIDI_OFFSET) - MIDI_OFFSET);
    let high = usize::from(params.max_pitch.saturating_sub(MIDI_OFFSET)).min(N_PITCHES - 1);
    (low, high)
}

/// Combines model onsets with onsets inferred from jumps in the note activations.
fn infer_onsets(onsets: &Grid, notes: &Grid) -> Grid {
    const N_DIFF: usize = 2;
    let mut diff = Grid::zeros(notes.rows(), notes.cols());
    for row in N_DIFF..notes.rows() {
        for col in 0..notes.cols() {
            let current = notes.get(row, col);
            let smallest_rise = (1..=N_DIFF).map(|n| current - notes.get(row - n, col)).fold(f32::INFINITY, f32::min);
            diff.set(row, col, smallest_rise.max(0.0));
        }
    }
    let diff_max = diff.max();
    let scale = if diff_max > 0.0 { onsets.max() / diff_max } else { 0.0 };
    let mut combined = onsets.clone();
    for row in 0..combined.rows() {
        for col in 0..combined.cols() {
            let inferred = diff.get(row, col) * scale;
            if inferred > combined.get(row, col) {
                combined.set(row, col, inferred);
            }
        }
    }
    combined
}

/// Returns `(frame, bin)` of onset peaks above the threshold, latest first.
fn onset_peaks(onsets: &Grid, threshold: f32, bins: (usize, usize)) -> Vec<(usize, usize)> {
    let mut peaks = Vec::new();
    for frame in 1..onsets.rows().saturating_sub(1) {
        for bin in bins.0..=bins.1 {
            let value = onsets.get(frame, bin);
            if value >= threshold && value > onsets.get(frame - 1, bin) && value > onsets.get(frame + 1, bin) {
                peaks.push((frame, bin));
            }
        }
    }
    peaks.reverse();
    peaks
}

/// Decodes note events from a posteriorgram.
pub fn decode_notes(posteriorgram: &Posteriorgram, params: &DecodeParams) -> Vec<Note> {
    let frames = &posteriorgram.notes;
    let n_frames = frames.rows();
    let bins = pitch_bin_range(params);

    let onsets =
        if params.infer_onsets { infer_onsets(&posteriorgram.onsets, frames) } else { posteriorgram.onsets.clone() };

    let mut remaining = frames.clone();
    let mut notes = Vec::new();

    // Going backwards in time means a later onset "claims" its energy first,
    // so an earlier note at the same pitch stops where the next one starts.
    for (start, bin) in onset_peaks(&onsets, params.onset_threshold, bins) {
        if start >= n_frames.saturating_sub(1) {
            continue;
        }
        let mut end = start + 1;
        let mut frames_below = 0;
        while end < n_frames - 1 && frames_below < params.energy_tolerance {
            if remaining.get(end, bin) < params.frame_threshold {
                frames_below += 1;
            } else {
                frames_below = 0;
            }
            end += 1;
        }
        end -= frames_below;
        if end - start <= params.min_note_frames {
            continue;
        }
        for frame in start..end {
            remaining.set(frame, bin, 0.0);
            if bin + 1 < N_PITCHES {
                remaining.set(frame, bin + 1, 0.0);
            }
            if bin > 0 {
                remaining.set(frame, bin - 1, 0.0);
            }
        }
        let amplitude = (start..end).map(|f| frames.get(f, bin)).sum::<f32>() / (end - start) as f32;
        notes.push(Note {
            start: posteriorgram.frame_times[start],
            end: posteriorgram.frame_times[end.min(n_frames - 1)],
            start_frame: start,
            end_frame: end,
            pitch: bin as u8 + MIDI_OFFSET,
            amplitude,
        });
    }

    notes.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.pitch.cmp(&b.pitch)));
    notes
}

/// Octave-below to own activation ratio from which a note is moved down.
///
/// Calibrated on a real bass stem against a pYIN reference: correct notes
/// show a median ratio of ~0.18, octave-up errors ~0.51. At 0.38 about three
/// quarters of the octave errors are fixed and ~5% of correct notes change.
const OCTAVE_DOWN_MIN_RATIO: f32 = 0.38;

/// Moves notes down an octave when the model also sees strong activation one
/// octave below them. On bass the model regularly reports the 2nd harmonic
/// instead of the fundamental. Notes are not moved below `min_pitch`.
/// Returns how many notes were corrected.
pub fn correct_octaves(notes: &mut [Note], posteriorgram: &Posteriorgram, min_pitch: u8) -> usize {
    let activations = &posteriorgram.notes;
    let mut corrected = 0;
    for note in notes.iter_mut() {
        let Some(lower) = note.pitch.checked_sub(12).filter(|p| *p >= min_pitch.max(MIDI_OFFSET)) else {
            continue;
        };
        let frames = note.start_frame..note.end_frame.min(activations.rows());
        if frames.is_empty() {
            continue;
        }
        let mean = |pitch: u8| {
            frames.clone().map(|f| activations.get(f, usize::from(pitch - MIDI_OFFSET))).sum::<f32>()
                / frames.len() as f32
        };
        let own = mean(note.pitch);
        if own > 0.0 && mean(lower) / own >= OCTAVE_DOWN_MIN_RATIO {
            note.pitch = lower;
            corrected += 1;
        }
    }
    corrected
}

/// Reduces overlapping notes to a single monophonic line.
///
/// Notes that start together are treated as harmonics / octave errors and
/// the lowest reasonably strong one is kept. A note that starts while the
/// previous one is still sounding cuts the previous one short.
pub fn to_monophonic(notes: &[Note]) -> Vec<Note> {
    let mut sorted = notes.to_vec();
    sorted.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.pitch.cmp(&b.pitch)));

    let mut line: Vec<Note> = Vec::with_capacity(sorted.len());
    for note in sorted {
        if let Some(last) = line.last_mut() {
            if note.start < last.end {
                if note.start - last.start < SIMULTANEOUS_WINDOW_S {
                    let (lower, higher) = if note.pitch < last.pitch { (&note, &*last) } else { (&*last, &note) };
                    let keep_lower = lower.amplitude >= LOWER_NOTE_MIN_RELATIVE_AMPLITUDE * higher.amplitude;
                    let winner = if keep_lower { lower.clone() } else { higher.clone() };
                    *last = winner;
                    continue;
                }
                last.end = note.start;
                last.end_frame = note.start_frame;
            }
        }
        line.push(note);
    }
    drop_pre_echoes(line)
}

/// Groups notes that start together into chords (each sorted from low to
/// high, all starting at the first note's time), in time order. A single
/// note is a chord of one.
///
/// Within a chord, repeated pitches are merged, weak notes and likely
/// overtones of a lower note are dropped, and at most six notes are kept.
/// A weak chord whose notes all ring on into the next, stronger chord is a
/// pre-echo of it and is dropped too.
pub fn to_chords(notes: &[Note]) -> Vec<Vec<Note>> {
    let mut sorted = notes.to_vec();
    sorted.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.pitch.cmp(&b.pitch)));

    let mut groups: Vec<Vec<Note>> = Vec::new();
    for note in sorted {
        match groups.last_mut() {
            Some(group) if note.start - group[0].start < SIMULTANEOUS_WINDOW_S => group.push(note),
            _ => groups.push(vec![note]),
        }
    }
    let chords: Vec<Vec<Note>> = groups.into_iter().map(clean_chord).collect();

    let strongest = |chord: &[Note]| chord.iter().map(|n| n.amplitude).fold(0.0, f32::max);
    let keep: Vec<bool> = (0..chords.len())
        .map(|i| {
            let Some(next) = chords.get(i + 1) else { return true };
            let chord = &chords[i];
            let is_pre_echo = chord.iter().all(|note| {
                next.iter().any(|n| n.pitch == note.pitch) && next[0].start - note.end <= PRE_ECHO_MAX_GAP_S
            }) && strongest(chord) < PRE_ECHO_MAX_RELATIVE_AMPLITUDE * strongest(next);
            !is_pre_echo
        })
        .collect();
    chords.into_iter().zip(keep).filter_map(|(chord, keep)| keep.then_some(chord)).collect()
}

fn clean_chord(mut group: Vec<Note>) -> Vec<Note> {
    let start = group[0].start;
    let start_frame = group[0].start_frame;
    // One note per pitch, the strongest.
    group.sort_by(|a, b| a.pitch.cmp(&b.pitch).then(b.amplitude.total_cmp(&a.amplitude)));
    group.dedup_by(|later, earlier| later.pitch == earlier.pitch);

    let strongest = group.iter().map(|n| n.amplitude).fold(0.0, f32::max);
    let is_overtone = |note: &Note, chord: &[Note]| {
        chord.iter().any(|lower| {
            OVERTONE_INTERVALS.contains(&note.pitch.wrapping_sub(lower.pitch))
                && note.pitch > lower.pitch
                && note.amplitude < OVERTONE_MAX_RELATIVE_AMPLITUDE * lower.amplitude
        })
    };
    let mut chord: Vec<Note> = group
        .iter()
        .filter(|note| note.amplitude >= CHORD_NOTE_MIN_RELATIVE_AMPLITUDE * strongest && !is_overtone(note, &group))
        .cloned()
        .collect();
    if chord.len() > MAX_CHORD_NOTES {
        chord.sort_by(|a, b| b.amplitude.total_cmp(&a.amplitude));
        chord.truncate(MAX_CHORD_NOTES);
        chord.sort_by_key(|note| note.pitch);
    }
    for note in &mut chord {
        note.start = start;
        note.start_frame = start_frame;
    }
    chord
}

/// Removes weak notes that run straight into a stronger note of the same
/// pitch. The model's long low-frequency analysis windows "see" an attack
/// coming and often emit such a pre-echo a sixteenth or so early.
fn drop_pre_echoes(line: Vec<Note>) -> Vec<Note> {
    let keep: Vec<bool> = (0..line.len())
        .map(|i| {
            let Some(next) = line.get(i + 1) else { return true };
            let note = &line[i];
            let is_pre_echo = next.pitch == note.pitch
                && next.start - note.end <= PRE_ECHO_MAX_GAP_S
                && note.amplitude < PRE_ECHO_MAX_RELATIVE_AMPLITUDE * next.amplitude;
            !is_pre_echo
        })
        .collect();
    line.into_iter().zip(keep).filter_map(|(note, keep)| keep.then_some(note)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(start: f64, end: f64, pitch: u8, amplitude: f32) -> Note {
        Note { start, end, start_frame: 0, end_frame: 0, pitch, amplitude }
    }

    fn posteriorgram_with(note_spans: &[(usize, usize, u8)], n_frames: usize) -> Posteriorgram {
        let mut notes = Grid::zeros(n_frames, N_PITCHES);
        let mut onsets = Grid::zeros(n_frames, N_PITCHES);
        for (start, end, pitch) in note_spans {
            let bin = usize::from(pitch - MIDI_OFFSET);
            onsets.set(*start, bin, 0.9);
            for frame in *start..*end {
                notes.set(frame, bin, 0.8);
            }
        }
        Posteriorgram {
            notes,
            onsets,
            contours: Grid::zeros(n_frames, N_PITCHES * 3),
            frame_times: (0..n_frames).map(|f| f as f64 * 0.01).collect(),
        }
    }

    #[test]
    fn decodes_notes_from_onsets_and_frames() {
        let post = posteriorgram_with(&[(10, 40, 28), (50, 90, 33)], 120);
        let notes = decode_notes(&post, &DecodeParams::default());
        let summary: Vec<(usize, usize, u8)> = notes.iter().map(|n| (n.start_frame, n.end_frame, n.pitch)).collect();
        assert_eq!(summary, vec![(10, 40, 28), (50, 90, 33)]);
        assert!((notes[0].amplitude - 0.8).abs() < 1e-6);
    }

    #[test]
    fn drops_notes_that_are_too_short() {
        let post = posteriorgram_with(&[(10, 15, 28)], 60);
        assert!(decode_notes(&post, &DecodeParams::default()).is_empty());
    }

    #[test]
    fn respects_the_pitch_range() {
        let post = posteriorgram_with(&[(10, 40, 28), (10, 40, 70)], 60);
        let params = DecodeParams { min_pitch: 23, max_pitch: 67, ..DecodeParams::default() };
        let pitches: Vec<u8> = decode_notes(&post, &params).iter().map(|n| n.pitch).collect();
        assert_eq!(pitches, vec![28]);
    }

    #[test]
    fn monophonic_keeps_the_fundamental_of_simultaneous_notes() {
        let line = to_monophonic(&[note(0.0, 1.0, 40, 0.6), note(0.01, 1.0, 28, 0.5)]);
        assert_eq!(line.len(), 1);
        assert_eq!(line[0].pitch, 28);
    }

    #[test]
    fn monophonic_prefers_a_much_stronger_higher_note() {
        let line = to_monophonic(&[note(0.0, 1.0, 40, 0.8), note(0.01, 1.0, 28, 0.2)]);
        assert_eq!(line[0].pitch, 40);
    }

    #[test]
    fn monophonic_drops_weak_pre_echoes_but_keeps_repeated_notes() {
        let line = to_monophonic(&[
            note(1.62, 1.71, 33, 0.26),
            note(1.71, 2.25, 33, 0.76),
            note(2.3, 2.6, 33, 0.7),
            note(2.6, 2.9, 33, 0.7),
        ]);
        let starts: Vec<f64> = line.iter().map(|n| n.start).collect();
        assert_eq!(starts, vec![1.71, 2.3, 2.6]);
    }

    #[test]
    fn monophonic_cuts_overlapping_notes() {
        let line = to_monophonic(&[note(0.0, 1.0, 28, 0.6), note(0.5, 1.5, 33, 0.6)]);
        assert_eq!(line.len(), 2);
        assert_eq!(line[0].end, 0.5);
    }

    #[test]
    fn groups_simultaneous_notes_into_chords() {
        // An E5 power chord (E2 B2 E3), then a single A2.
        let chords = to_chords(&[
            note(0.0, 1.0, 40, 0.8),
            note(0.02, 1.0, 47, 0.7),
            note(0.01, 1.0, 52, 0.7),
            note(1.0, 2.0, 45, 0.8),
        ]);
        let pitches: Vec<Vec<u8>> = chords.iter().map(|c| c.iter().map(|n| n.pitch).collect()).collect();
        assert_eq!(pitches, vec![vec![40, 47, 52], vec![45]]);
        assert!(chords[0].iter().all(|n| n.start == 0.0));
    }

    #[test]
    fn chords_drop_weak_notes_and_overtones() {
        let chords = to_chords(&[
            note(0.0, 1.0, 45, 0.8),
            // A weak octave above: an overtone of the A.
            note(0.0, 1.0, 57, 0.3),
            // Far too weak to be part of the chord.
            note(0.01, 1.0, 49, 0.1),
            note(0.01, 1.0, 52, 0.7),
        ]);
        let pitches: Vec<u8> = chords[0].iter().map(|n| n.pitch).collect();
        assert_eq!(pitches, vec![45, 52]);
    }

    #[test]
    fn chords_drop_pre_echoes() {
        let chords = to_chords(&[note(0.0, 0.49, 40, 0.2), note(0.5, 1.0, 40, 0.8), note(0.5, 1.0, 47, 0.8)]);
        assert_eq!(chords.len(), 1);
        assert_eq!(chords[0].len(), 2);
    }
}
