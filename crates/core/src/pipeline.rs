//! End-to-end transcription of mono bass or guitar audio into tablature.

use anyhow::{bail, Result};
use log::{debug, info, warn};

use crate::analysis::{self, Tempo, TuningEstimate};
use crate::fretboard::{self, FingeringStyle, Position};
use crate::instrument::Instrument;
use crate::midi;
use crate::model::{BasicPitch, MIDI_OFFSET};
use crate::notes::{self, DecodeParams, Note};
use crate::onsets::{self, RefineStats};
use crate::tab::{self, TabEvent};
use crate::tuning::{pitch_name, Tuning};

/// Recording tuning further than this from A440 is worth a warning.
const TUNING_WARNING_CENTS: f64 = 30.0;
/// Model frames per second (Basic Pitch hop of 256 samples at 22.05 kHz).
const MODEL_FRAMES_PER_SECOND: f64 = 86.0;

/// User-facing transcription settings.
#[derive(Clone, Debug)]
pub struct Options {
    pub instrument: Instrument,
    pub tuning: Tuning,
    pub frets: u8,
    /// Tempo in BPM; estimated from the notes when `None`.
    pub bpm: Option<f64>,
    pub onset_threshold: f32,
    pub frame_threshold: f32,
    pub min_note_ms: f64,
    pub bars_per_line: usize,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            instrument: Instrument::Bass,
            tuning: Tuning::from_spec("standard").expect("built-in preset"),
            frets: 24,
            bpm: None,
            onset_threshold: 0.5,
            frame_threshold: 0.3,
            min_note_ms: 80.0,
            bars_per_line: 4,
        }
    }
}

/// A detected note and the pitch written in the tab.
#[derive(Clone, Debug)]
pub struct TabNote {
    pub note: Note,
    /// Pitch actually written in the tab (shifted by octaves if out of range).
    pub played_pitch: u8,
}

/// The tab for one fingering style. All styles share the notes and rhythm;
/// only strings and frets differ.
#[derive(Clone, Debug)]
pub struct Fingering {
    pub style: FingeringStyle,
    /// Position of each note in [`Transcription::notes`] (`None` if unplayable).
    pub positions: Vec<Option<Position>>,
    /// Notes placed on the sixteenth-note grid, for interactive rendering.
    pub events: Vec<TabEvent>,
    /// ASCII tablature.
    pub tab: String,
}

/// Everything the transcription produced.
#[derive(Clone, Debug)]
pub struct Transcription {
    pub notes: Vec<TabNote>,
    pub tempo: Tempo,
    pub tuning_estimate: Option<TuningEstimate>,
    /// One tab per [`FingeringStyle`], in the order of [`FingeringStyle::ALL`].
    pub fingerings: Vec<Fingering>,
    /// Standard MIDI file with the detected notes.
    pub midi: Vec<u8>,
    /// Human-readable problems worth showing to the user.
    pub warnings: Vec<String>,
    pub raw_note_count: usize,
    pub refine_stats: RefineStats,
}

impl Transcription {
    /// The tab for `style`.
    pub fn fingering(&self, style: FingeringStyle) -> &Fingering {
        self.fingerings.iter().find(|f| f.style == style).expect("every style is transcribed")
    }
}

fn decode_params(options: &Options) -> DecodeParams {
    DecodeParams {
        onset_threshold: options.onset_threshold,
        frame_threshold: options.frame_threshold,
        min_note_frames: (options.min_note_ms / 1000.0 * MODEL_FRAMES_PER_SECOND).round() as usize,
        // Decode below the lowest string so octave errors and lower tunings can be reported.
        min_pitch: MIDI_OFFSET,
        max_pitch: options.tuning.highest_open().saturating_add(options.frets),
        ..DecodeParams::default()
    }
}

fn tuning_warning(estimate: Option<TuningEstimate>) -> Option<String> {
    match estimate {
        Some(estimate) => {
            info!(
                "Recording tuning: A4 = {:.1} Hz ({:+.0} cents, {} frames)",
                estimate.reference_a4_hz(),
                estimate.cents,
                estimate.frames
            );
            (estimate.cents.abs() > TUNING_WARNING_CENTS).then(|| {
                format!(
                    "The recording is {:+.0} cents off A440; some notes may land on the neighbouring semitone.",
                    estimate.cents
                )
            })
        }
        None => Some("Could not estimate the recording tuning.".to_string()),
    }
}

/// Shifts notes the instrument cannot play by octaves. Returns the pitches to
/// write in the tab and a warning if any note was moved.
fn fit_pitches(line: &[Note], options: &Options) -> (Vec<u8>, Option<String>) {
    let played: Vec<u8> = line
        .iter()
        .map(|note| fretboard::fit_to_range(note.pitch, &options.tuning, options.frets).unwrap_or(note.pitch))
        .collect();
    let shifted = line.iter().zip(&played).filter(|(note, played)| note.pitch != **played).count();
    let warning = (shifted > 0).then(|| {
        format!(
            "{shifted} notes were outside the range of {} and were shifted by octaves; \
             if the song uses a lower tuning, try {}.",
            options.tuning.describe(),
            match options.instrument {
                Instrument::Bass => "Drop D or a 5-string tuning",
                Instrument::Guitar => "Drop D or a lower tuning",
            }
        )
    });
    (played, warning)
}

/// Fingers `played` in `style` and renders the tab.
fn finger(line: &[Note], played: &[u8], tempo: &Tempo, options: &Options, style: FingeringStyle) -> Fingering {
    let positions = fretboard::assign_positions(played, &options.tuning, options.frets, style);
    let events = tab::build_events(line, &positions, tempo);
    let tab = tab::render(&events, &options.tuning, options.bars_per_line);
    Fingering { style, positions, events, tab }
}

/// Transcribes mono audio sampled at [`crate::model::SAMPLE_RATE`].
/// `progress(done, total)` is called as the model processes the audio.
pub fn transcribe(
    model: &BasicPitch,
    samples: &[f32],
    options: &Options,
    progress: &mut dyn FnMut(usize, usize),
) -> Result<Transcription> {
    info!("{:?} tuning: {} ({} frets)", options.instrument, options.tuning.describe(), options.frets);
    let posteriorgram = model.run_with_progress(samples, progress)?;

    let raw = notes::decode_notes(&posteriorgram, &decode_params(options));
    for note in &raw {
        debug!(
            "Raw note {:>7.3}-{:>7.3} s {:<4} amplitude {:.2}",
            note.start,
            note.end,
            pitch_name(note.pitch),
            note.amplitude
        );
    }
    let mut line = notes::to_monophonic(&raw);
    if options.instrument.corrects_octaves() {
        let octave_fixes = notes::correct_octaves(&mut line, &posteriorgram, options.tuning.lowest());
        info!("Moved {octave_fixes} notes down an octave (harmonic detected instead of the fundamental)");
    }
    let refine_stats = onsets::refine_onsets(&mut line, samples, crate::model::SAMPLE_RATE);
    info!(
        "Detected {} notes ({} raw; {} onsets refined, {} pre-echoes dropped)",
        line.len(),
        raw.len(),
        refine_stats.adjusted,
        refine_stats.dropped
    );
    if line.is_empty() {
        bail!(
            "No notes were detected. Try a lower onset threshold, or check that the audio contains {}.",
            options.instrument.name()
        );
    }

    let mut warnings = Vec::new();
    let tuning_estimate = analysis::estimate_tuning(&posteriorgram, &line);
    warnings.extend(tuning_warning(tuning_estimate));

    let tempo = analysis::estimate_tempo(&line, options.bpm);
    info!("Tempo: {:.1} BPM, grid starts at {:.2} s", tempo.bpm, tempo.origin);

    let (played, range_warning) = fit_pitches(&line, options);
    warnings.extend(range_warning);
    for warning in &warnings {
        warn!("{warning}");
    }

    let fingerings = FingeringStyle::ALL.iter().map(|style| finger(&line, &played, &tempo, options, *style)).collect();
    let midi = midi::encode(&line, tempo.bpm, options.instrument)?;

    let notes = line.into_iter().zip(played).map(|(note, played_pitch)| TabNote { note, played_pitch }).collect();
    Ok(Transcription {
        notes,
        tempo,
        tuning_estimate,
        fingerings,
        midi,
        warnings,
        raw_note_count: raw.len(),
        refine_stats,
    })
}
