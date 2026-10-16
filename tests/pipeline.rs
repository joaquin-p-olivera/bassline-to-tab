//! End-to-end check: synthesize a known bass riff, run the real model and
//! make sure the transcription recovers the notes and the tempo.

use bassline_to_tab::analysis::estimate_tempo;
use bassline_to_tab::model::{BasicPitch, SAMPLE_RATE};
use bassline_to_tab::notes::{decode_notes, to_monophonic, DecodeParams};
use bassline_to_tab::onsets::refine_onsets;

const BPM: f64 = 100.0;
const LEAD_IN_S: f64 = 0.5;
/// (MIDI pitch, length in eighth notes): a two-bar riff in E.
const RIFF: [(u8, usize); 12] =
    [(28, 2), (28, 1), (31, 1), (33, 2), (35, 1), (36, 1), (38, 2), (36, 1), (35, 1), (33, 2), (31, 1), (30, 1)];

/// Harmonic tone with a fast attack and exponential decay, like a plucked string.
fn pluck(frequency: f64, seconds: f64) -> Vec<f32> {
    let sample_rate = f64::from(SAMPLE_RATE);
    (0..(seconds * sample_rate) as usize)
        .map(|i| {
            let t = i as f64 / sample_rate;
            let tone: f64 = (1..=8)
                .map(f64::from)
                .filter(|h| frequency * h < sample_rate / 2.0)
                .map(|h| (2.0 * std::f64::consts::PI * frequency * h * t).sin() / h.powf(1.2))
                .sum();
            let envelope = (t / 0.005).min(1.0) * (-t * 3.0).exp() * ((seconds - t) / 0.01).min(1.0);
            (0.15 * tone * envelope) as f32
        })
        .collect()
}

fn synthesize_riff(repeats: usize) -> Vec<f32> {
    let eighth = 60.0 / BPM / 2.0;
    let mut audio = vec![0.0f32; (LEAD_IN_S * f64::from(SAMPLE_RATE)) as usize];
    for _ in 0..repeats {
        for (pitch, length) in RIFF {
            let frequency = 440.0 * 2f64.powf((f64::from(pitch) - 69.0) / 12.0);
            audio.extend(pluck(frequency, length as f64 * eighth));
        }
    }
    audio.extend(vec![0.0f32; SAMPLE_RATE as usize]);
    audio
}

#[test]
fn transcribes_a_synthetic_riff() {
    let repeats = 2;
    let audio = synthesize_riff(repeats);
    let posteriorgram = BasicPitch::load().unwrap().run(&audio).unwrap();

    let raw = decode_notes(&posteriorgram, &DecodeParams { max_pitch: 67, ..DecodeParams::default() });
    let mut line = to_monophonic(&raw);
    refine_onsets(&mut line, &audio, SAMPLE_RATE);

    let detected: Vec<u8> = line.iter().map(|n| n.pitch).collect();
    let expected: Vec<u8> = (0..repeats).flat_map(|_| RIFF.iter().map(|(pitch, _)| *pitch)).collect();
    assert_eq!(detected, expected);

    let tempo = estimate_tempo(&line, None);
    assert!((tempo.bpm - BPM).abs() < 1.0, "tempo was {}", tempo.bpm);
    assert!((tempo.origin - LEAD_IN_S).abs() < 0.03, "grid origin was {}", tempo.origin);
}
