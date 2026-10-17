//! Onset time refinement from the audio waveform.
//!
//! The model's onset activations lag on low notes (tens of milliseconds on
//! the low E), which is enough to push notes onto the wrong sixteenth. A
//! plucked bass note has a sharp energy rise, so each note start is moved to
//! the steepest rise of the short-time energy close to the model's estimate.

use crate::notes::Note;

/// Short-time energy frame length and hop, in seconds.
const FRAME_S: f64 = 0.012;
const HOP_S: f64 = 0.003;
/// Energy rise is measured over this many hops (~9 ms).
const RISE_HOPS: usize = 3;
/// Search window around the model's onset estimate, in seconds.
const SEARCH_BEFORE_S: f64 = 0.09;
const SEARCH_AFTER_S: f64 = 0.03;
/// Minimum rise in dB for a refinement to be trusted.
const MIN_RISE_DB: f64 = 6.0;

/// Log-energy envelope in dB, one value per hop.
fn energy_envelope(audio: &[f32], sample_rate: u32) -> (Vec<f64>, f64) {
    let frame = (FRAME_S * f64::from(sample_rate)) as usize;
    let hop = ((HOP_S * f64::from(sample_rate)) as usize).max(1);
    let envelope = (0..audio.len().saturating_sub(frame))
        .step_by(hop)
        .map(|start| {
            let energy: f64 =
                audio[start..start + frame].iter().map(|s| f64::from(*s).powi(2)).sum::<f64>() / frame as f64;
            10.0 * (energy + 1e-10).log10()
        })
        .collect();
    (envelope, hop as f64 / f64::from(sample_rate))
}

/// A note is treated as a pre-echo of the next one only if all of these hold:
/// it has no attack of its own, the next note has the same pitch and starts
/// within this gap, it is short, and it is clearly weaker. On real bass lines,
/// repeated notes often have soft attacks, so a looser rule deletes real notes.
const PRE_ECHO_MAX_GAP_S: f64 = 0.03;
const PRE_ECHO_MAX_DURATION_S: f64 = 0.15;
const PRE_ECHO_MAX_RELATIVE_AMPLITUDE: f32 = 0.7;

/// What [`refine_onsets`] changed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RefineStats {
    /// Notes whose start moved to an attack found in the audio.
    pub adjusted: usize,
    /// Pre-echo notes removed.
    pub dropped: usize,
}

/// Moves each note start to the strongest energy rise near it, then removes
/// notes with no attack of their own that run into a note of the same pitch
/// (the model often announces a low note a sixteenth early).
pub fn refine_onsets(notes: &mut Vec<Note>, audio: &[f32], sample_rate: u32) -> RefineStats {
    let (envelope, hop_seconds) = energy_envelope(audio, sample_rate);
    if envelope.len() <= RISE_HOPS {
        return RefineStats::default();
    }
    // Rise at hop i compares the energy after the attack with the energy before it.
    let frame_center = FRAME_S / 2.0;
    let rise = |i: usize| envelope[i] - envelope[i - RISE_HOPS];

    let mut stats = RefineStats::default();
    let mut confirmed = vec![false; notes.len()];
    let mut previous_start = f64::NEG_INFINITY;
    for (note, confirmed) in notes.iter_mut().zip(confirmed.iter_mut()) {
        let lower =
            ((note.start - SEARCH_BEFORE_S).max(previous_start + 0.02) / hop_seconds).ceil().max(RISE_HOPS as f64);
        let upper = ((note.start + SEARCH_AFTER_S) / hop_seconds).floor().min((envelope.len() - 1) as f64);
        if lower <= upper {
            let best = (lower as usize..=upper as usize).max_by(|a, b| rise(*a).total_cmp(&rise(*b)));
            if let Some(best) = best.filter(|i| rise(*i) >= MIN_RISE_DB) {
                // The steepest rise sits between the frame that starts before the
                // attack and the one that contains it; take the midpoint.
                let refined = (best as f64 - RISE_HOPS as f64 / 2.0) * hop_seconds + frame_center;
                if refined < note.end {
                    note.start = refined;
                    *confirmed = true;
                    stats.adjusted += 1;
                }
            }
        }
        previous_start = note.start;
    }

    let is_pre_echo = |i: usize| {
        let (note, next) = (&notes[i], notes.get(i + 1));
        !confirmed[i]
            && note.end - note.start < PRE_ECHO_MAX_DURATION_S
            && next.is_some_and(|next| {
                next.pitch == note.pitch
                    && next.start - note.end <= PRE_ECHO_MAX_GAP_S
                    && note.amplitude < PRE_ECHO_MAX_RELATIVE_AMPLITUDE * next.amplitude
            })
    };
    let keep: Vec<bool> = (0..notes.len()).map(|i| !is_pre_echo(i)).collect();
    let before = notes.len();
    let mut keep_iter = keep.into_iter();
    notes.retain(|_| keep_iter.next().unwrap_or(true));
    stats.dropped = before - notes.len();
    stats
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 22_050;

    fn plucks(onsets: &[f64], seconds: f64) -> Vec<f32> {
        let mut audio = vec![0.0f32; (seconds * f64::from(SR)) as usize];
        for onset in onsets {
            let start = (onset * f64::from(SR)) as usize;
            for (i, sample) in audio[start..].iter_mut().enumerate().take(SR as usize / 2) {
                let t = i as f64 / f64::from(SR);
                *sample += ((2.0 * std::f64::consts::PI * 55.0 * t).sin() * (-t * 6.0).exp() * 0.5) as f32;
            }
        }
        audio
    }

    fn note(start: f64) -> Note {
        Note { start, end: start + 0.4, start_frame: 0, end_frame: 0, pitch: 33, amplitude: 0.7 }
    }

    #[test]
    fn snaps_late_onsets_to_the_attack() {
        let audio = plucks(&[0.5, 1.1], 2.0);
        let mut notes = vec![note(0.55), note(1.12)];
        assert_eq!(refine_onsets(&mut notes, &audio, SR), RefineStats { adjusted: 2, dropped: 0 });
        assert!((notes[0].start - 0.5).abs() < 0.008, "got {}", notes[0].start);
        assert!((notes[1].start - 1.1).abs() < 0.008, "got {}", notes[1].start);
    }

    #[test]
    fn leaves_notes_without_a_clear_attack_alone() {
        let audio = vec![0.1f32; SR as usize];
        let mut notes = vec![note(0.5)];
        assert_eq!(refine_onsets(&mut notes, &audio, SR), RefineStats::default());
        assert_eq!(notes[0].start, 0.5);
    }

    #[test]
    fn drops_pre_echoes_without_an_attack() {
        // One real pluck at 1.0 s; the model also reported the same pitch from 0.9 s.
        let audio = plucks(&[1.0], 2.0);
        let mut notes = vec![Note { end: 0.98, amplitude: 0.3, ..note(0.9) }, note(0.98)];
        let stats = refine_onsets(&mut notes, &audio, SR);
        assert_eq!(stats, RefineStats { adjusted: 1, dropped: 1 });
        assert_eq!(notes.len(), 1);
        assert!((notes[0].start - 1.0).abs() < 0.008, "got {}", notes[0].start);
    }

    #[test]
    fn keeps_long_or_strong_notes_even_without_an_attack() {
        // Legato repeated notes on real bass often show no clear energy rise.
        let audio = vec![0.1f32; 2 * SR as usize];
        let mut long = vec![Note { end: 0.9, ..note(0.5) }, note(0.9)];
        assert_eq!(refine_onsets(&mut long, &audio, SR).dropped, 0);
        let mut strong = vec![Note { end: 0.6, amplitude: 0.7, ..note(0.5) }, note(0.6)];
        assert_eq!(refine_onsets(&mut strong, &audio, SR).dropped, 0);
    }

    #[test]
    fn keeps_repeated_notes_that_each_have_an_attack() {
        let audio = plucks(&[0.5, 0.8], 1.5);
        let mut notes = vec![Note { end: 0.82, ..note(0.52) }, note(0.82)];
        assert_eq!(refine_onsets(&mut notes, &audio, SR), RefineStats { adjusted: 2, dropped: 0 });
    }
}
