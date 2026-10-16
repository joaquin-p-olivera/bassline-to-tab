use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use clap::Parser;
use log::{debug, info, warn, LevelFilter};

use bassline_to_tab::analysis::{self, Tempo, TuningEstimate};
use bassline_to_tab::fretboard::{self, Position};
use bassline_to_tab::model::{self, BasicPitch};
use bassline_to_tab::notes::{self, DecodeParams, Note};
use bassline_to_tab::tuning::{pitch_name, Tuning};
use bassline_to_tab::{audio, midi, onsets, separation, tab};

/// Transcribe the bass line of a song into bass tablature.
#[derive(Parser, Debug)]
#[command(version, about)]
struct Args {
    /// Audio file to transcribe (wav, mp3, flac, ogg, m4a, ...).
    input: PathBuf,

    /// Bass tuning: standard, drop-d, half-step-down, d-standard, five-string,
    /// six-string, or explicit notes from low to high such as "E1 A1 D2 G2".
    #[arg(short, long, default_value = "standard")]
    tuning: String,

    /// Number of frets on the bass.
    #[arg(long, default_value_t = 24)]
    frets: u8,

    /// Tempo in BPM. Estimated from the notes when omitted.
    #[arg(long)]
    bpm: Option<f64>,

    /// Skip Demucs and transcribe the input as-is (use for isolated bass recordings).
    #[arg(long)]
    no_separate: bool,

    /// Demucs model used for separation.
    #[arg(long, default_value = "htdemucs")]
    demucs_model: String,

    /// Command used to run Demucs, e.g. "python3 -m demucs". Autodetected when omitted.
    #[arg(long)]
    demucs_cmd: Option<String>,

    /// Directory where Demucs writes its stems. Defaults to a temp directory.
    #[arg(long)]
    work_dir: Option<PathBuf>,

    /// Write the tab to this file instead of stdout.
    #[arg(short, long)]
    output: Option<PathBuf>,

    /// Also write the transcription as a MIDI file.
    #[arg(long)]
    midi: Option<PathBuf>,

    /// Bars per tab line.
    #[arg(long, default_value_t = 4)]
    bars_per_line: usize,

    /// Minimum onset activation (0-1). Lower finds more notes, and more false ones.
    #[arg(long, default_value_t = 0.5)]
    onset_threshold: f32,

    /// Minimum note activation (0-1) for a note to keep sounding.
    #[arg(long, default_value_t = 0.3)]
    frame_threshold: f32,

    /// Notes shorter than this (milliseconds) are discarded.
    #[arg(long, default_value_t = 80.0)]
    min_note_ms: f64,

    /// More logging (-v debug, -vv trace).
    #[arg(short, long, action = clap::ArgAction::Count)]
    verbose: u8,

    /// Only log warnings and errors.
    #[arg(short, long)]
    quiet: bool,
}

/// Recording tuning further than this from A440 is worth a warning.
const TUNING_WARNING_CENTS: f64 = 30.0;
/// Model frames per second (Basic Pitch hop of 256 samples at 22.05 kHz).
const MODEL_FRAMES_PER_SECOND: f64 = 86.0;

fn init_logging(args: &Args) {
    let level = match (args.quiet, args.verbose) {
        (true, _) => LevelFilter::Warn,
        (false, 0) => LevelFilter::Info,
        (false, 1) => LevelFilter::Debug,
        (false, _) => LevelFilter::Trace,
    };
    env_logger::Builder::new()
        .filter_level(LevelFilter::Warn)
        .filter_module("bassline_to_tab", level)
        .format_timestamp(None)
        .parse_default_env()
        .init();
}

/// Returns the audio file to transcribe: the Demucs bass stem when possible,
/// otherwise the original input.
fn prepare_source_audio(args: &Args) -> Result<PathBuf> {
    if args.no_separate {
        info!("Skipping separation (--no-separate)");
        return Ok(args.input.clone());
    }
    match separation::find_demucs(args.demucs_cmd.as_deref()) {
        Some(command) => {
            let work_dir = args.work_dir.clone().unwrap_or_else(|| std::env::temp_dir().join("bassline-to-tab"));
            separation::separate_bass(&command, &args.input, &work_dir, &args.demucs_model)
        }
        None if args.demucs_cmd.is_some() => {
            bail!("the Demucs command '{}' does not work", args.demucs_cmd.as_deref().unwrap_or_default())
        }
        None => {
            warn!(
                "Demucs not found: transcribing the full mix, expect extra notes from other instruments. \
                 Install it with `pipx install demucs`, or pass --no-separate for isolated bass recordings."
            );
            Ok(args.input.clone())
        }
    }
}

fn decode_params(args: &Args, tuning: &Tuning) -> DecodeParams {
    DecodeParams {
        onset_threshold: args.onset_threshold,
        frame_threshold: args.frame_threshold,
        min_note_frames: (args.min_note_ms / 1000.0 * MODEL_FRAMES_PER_SECOND).round() as usize,
        // Decode below the lowest string so octave errors and drop tunings can be detected and reported.
        min_pitch: model::MIDI_OFFSET,
        max_pitch: tuning.highest_open().saturating_add(args.frets),
        ..DecodeParams::default()
    }
}

fn transcribe(source: &Path, params: &DecodeParams) -> Result<(model::Posteriorgram, Vec<Note>)> {
    let samples = audio::load_resampled(source, model::SAMPLE_RATE)?;
    let started = Instant::now();
    let posteriorgram = BasicPitch::load()?.run(&samples)?;
    info!("Inference took {:.1} s", started.elapsed().as_secs_f64());

    let raw = notes::decode_notes(&posteriorgram, params);
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
    let stats = onsets::refine_onsets(&mut line, &samples, model::SAMPLE_RATE);
    info!(
        "Detected {} notes ({} raw; {} onsets refined from the audio, {} pre-echoes dropped)",
        line.len(),
        raw.len(),
        stats.adjusted,
        stats.dropped
    );
    Ok((posteriorgram, line))
}

fn report_tuning(estimate: Option<TuningEstimate>) {
    match estimate {
        Some(estimate) => {
            info!(
                "Recording tuning: A4 = {:.1} Hz ({:+.0} cents, {} frames)",
                estimate.reference_a4_hz(),
                estimate.cents,
                estimate.frames
            );
            if estimate.cents.abs() > TUNING_WARNING_CENTS {
                warn!(
                    "The recording is {:+.0} cents off A440; some notes may be assigned to the neighbouring semitone",
                    estimate.cents
                );
            }
        }
        None => warn!("Could not estimate the recording tuning"),
    }
}

/// Maps notes onto the neck, shifting unplayable notes by octaves.
fn assign_frets(line: &[Note], tuning: &Tuning, frets: u8) -> Vec<Option<Position>> {
    let mut shifted = 0;
    let pitches: Vec<u8> = line
        .iter()
        .map(|note| {
            let fitted = fretboard::fit_to_range(note.pitch, tuning, frets).unwrap_or(note.pitch);
            if fitted != note.pitch {
                shifted += 1;
            }
            fitted
        })
        .collect();
    if shifted > 0 {
        warn!(
            "{shifted} notes were outside the range of {} and were shifted by octaves; \
             if the song uses a lower tuning, try --tuning drop-d or --tuning five-string",
            tuning.describe()
        );
    }
    fretboard::assign_positions(&pitches, tuning, frets)
}

fn format_report(
    args: &Args,
    tuning: &Tuning,
    tempo: &Tempo,
    estimate: Option<TuningEstimate>,
    n_notes: usize,
) -> String {
    let name = args.input.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tempo_source = if args.bpm.is_some() { "given" } else { "estimated" };
    let recording = estimate
        .map(|e| format!("A4 = {:.1} Hz ({:+.0} cents)", e.reference_a4_hz(), e.cents))
        .unwrap_or_else(|| "unknown".to_string());
    format!(
        "{name}\nBass tuning: {} ({})\nTempo: {:.1} BPM ({tempo_source}), 4/4\nRecording tuning: {recording}\nNotes: {n_notes}\n\n",
        tuning.describe(),
        args.tuning,
        tempo.bpm
    )
}

fn write_output(path: Option<&Path>, text: &str) -> Result<()> {
    match path {
        Some(path) => {
            std::fs::write(path, text).with_context(|| format!("cannot write {}", path.display()))?;
            info!("Tab written to {}", path.display());
        }
        None => print!("{text}"),
    }
    Ok(())
}

fn run(args: &Args) -> Result<()> {
    let started = Instant::now();
    let tuning = Tuning::from_spec(&args.tuning)?;
    info!("Bass tuning: {} ({} frets)", tuning.describe(), args.frets);

    let source = prepare_source_audio(args)?;
    let (posteriorgram, line) = transcribe(&source, &decode_params(args, &tuning))?;
    if line.is_empty() {
        bail!("no notes were detected; try lowering --onset-threshold");
    }

    let tuning_estimate = analysis::estimate_tuning(&posteriorgram, &line);
    report_tuning(tuning_estimate);
    let tempo = analysis::estimate_tempo(&line, args.bpm);
    info!("Tempo: {:.1} BPM, grid starts at {:.2} s", tempo.bpm, tempo.origin);

    let positions = assign_frets(&line, &tuning, args.frets);
    let events = tab::build_events(&line, &positions, &tempo);
    let text = format_report(args, &tuning, &tempo, tuning_estimate, events.len())
        + &tab::render(&events, &tuning, args.bars_per_line);

    if let Some(midi_path) = &args.midi {
        midi::write(midi_path, &line, tempo.bpm)?;
        info!("MIDI written to {}", midi_path.display());
    }
    write_output(args.output.as_deref(), &text)?;
    info!("Done in {:.1} s", started.elapsed().as_secs_f64());
    Ok(())
}

fn main() {
    let args = Args::parse();
    init_logging(&args);
    if let Err(error) = run(&args) {
        log::error!("{error:#}");
        std::process::exit(1);
    }
}
