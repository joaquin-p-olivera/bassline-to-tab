//! WebAssembly bindings for the browser app.
//!
//! Two entry points, both meant to run inside a Web Worker:
//! - [`separate_bass`]: isolates the bass stem with HTDemucs on WebGPU
//!   (via `demucs-core` from demucs-rs).
//! - [`transcribe`]: turns mono bass audio at 22.05 kHz into tablature with
//!   `bassline-core`.
//!
//! Audio decoding and resampling happen in JavaScript (Web Audio API).

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};

use bassline_core::model::{BasicPitch, SAMPLE_RATE};
use bassline_core::pipeline::{self, Options, Transcription};
use bassline_core::tab;
use bassline_core::tuning::{pitch_name, Tuning};
use burn::backend::wgpu::graphics::WebGpu;
use burn::backend::wgpu::{init_setup_async, RuntimeOptions, Wgpu, WgpuDevice};
use demucs_core::listener::{ForwardEvent, ForwardListener};
use demucs_core::model::metadata::{self, StemId, HTDEMUCS};
use demucs_core::{Demucs, ModelOptions};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

type Backend = Wgpu;

static WGPU_INITIALIZED: AtomicBool = AtomicBool::new(false);

thread_local! {
    /// The Basic Pitch model is small but takes a moment to optimize; keep it.
    static BASIC_PITCH: RefCell<Option<Rc<BasicPitch>>> = const { RefCell::new(None) };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Forwards Demucs chunk progress to a JS callback `(done, total) => void`.
struct ChunkProgress {
    callback: Option<js_sys::Function>,
}

impl ForwardListener for ChunkProgress {
    fn on_event(&mut self, event: ForwardEvent) {
        if let (ForwardEvent::ChunkDone { index, total }, Some(callback)) = (&event, &self.callback) {
            let _ = callback.call2(&JsValue::NULL, &JsValue::from(*index as u32 + 1), &JsValue::from(*total as u32));
        }
    }
}

fn js_error(error: impl std::fmt::Display) -> JsError {
    JsError::new(&error.to_string())
}

async fn webgpu_device() -> WgpuDevice {
    let device = WgpuDevice::default();
    if !WGPU_INITIALIZED.swap(true, Ordering::SeqCst) {
        log::info!("Initializing WebGPU");
        init_setup_async::<WebGpu>(&device, RuntimeOptions { tasks_max: 128, ..Default::default() }).await;
    }
    device
}

fn basic_pitch() -> Result<Rc<BasicPitch>, JsError> {
    BASIC_PITCH.with(|cell| {
        if let Some(model) = cell.borrow().as_ref() {
            return Ok(Rc::clone(model));
        }
        log::info!("Loading Basic Pitch");
        let model = Rc::new(BasicPitch::load().map_err(js_error)?);
        *cell.borrow_mut() = Some(Rc::clone(&model));
        Ok(model)
    })
}

/// Options as sent from JavaScript (camelCase, everything but tuning optional).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsOptions {
    tuning: String,
    frets: Option<u8>,
    bpm: Option<f64>,
    onset_threshold: Option<f32>,
    frame_threshold: Option<f32>,
    min_note_ms: Option<f64>,
    bars_per_line: Option<usize>,
}

impl JsOptions {
    fn into_options(self) -> anyhow::Result<Options> {
        let defaults = Options::default();
        Ok(Options {
            tuning: Tuning::from_spec(&self.tuning)?,
            frets: self.frets.unwrap_or(defaults.frets),
            bpm: self.bpm.filter(|bpm| *bpm > 0.0),
            onset_threshold: self.onset_threshold.unwrap_or(defaults.onset_threshold),
            frame_threshold: self.frame_threshold.unwrap_or(defaults.frame_threshold),
            min_note_ms: self.min_note_ms.unwrap_or(defaults.min_note_ms),
            bars_per_line: self.bars_per_line.unwrap_or(defaults.bars_per_line).max(1),
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsNote {
    start: f64,
    end: f64,
    name: String,
    pitch: u8,
    played_pitch: u8,
    string: Option<String>,
    fret: Option<u8>,
    amplitude: f32,
}

/// One fretted note on the sixteenth-note grid.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsTabEvent {
    step: usize,
    /// 0 is the lowest-pitched string.
    string: usize,
    fret: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsTranscription {
    tab: String,
    events: Vec<JsTabEvent>,
    /// Open-string labels, lowest string first.
    string_labels: Vec<String>,
    steps_per_bar: usize,
    steps_per_beat: usize,
    bpm: f64,
    grid_origin: f64,
    tuning: String,
    tuning_cents: Option<f64>,
    reference_a4_hz: Option<f64>,
    notes: Vec<JsNote>,
    warnings: Vec<String>,
    raw_note_count: usize,
    refined_onsets: usize,
    dropped_pre_echoes: usize,
    #[serde(with = "serde_bytes")]
    midi: Vec<u8>,
}

fn to_js_transcription(result: Transcription, tuning: &Tuning) -> JsTranscription {
    let notes = result
        .notes
        .iter()
        .map(|n| JsNote {
            start: n.note.start,
            end: n.note.end,
            name: pitch_name(n.played_pitch),
            pitch: n.note.pitch,
            played_pitch: n.played_pitch,
            string: n.position.map(|p| tuning.label(p.string)),
            fret: n.position.map(|p| p.fret),
            amplitude: n.note.amplitude,
        })
        .collect();
    let events = result
        .events
        .iter()
        .map(|e| JsTabEvent { step: e.step, string: e.position.string, fret: e.position.fret })
        .collect();
    JsTranscription {
        tab: result.tab,
        events,
        string_labels: (0..tuning.strings().len()).map(|s| tuning.label(s)).collect(),
        steps_per_bar: tab::STEPS_PER_BAR,
        steps_per_beat: tab::STEPS_PER_BEAT,
        bpm: result.tempo.bpm,
        grid_origin: result.tempo.origin,
        tuning: tuning.describe(),
        tuning_cents: result.tuning_estimate.map(|t| t.cents),
        reference_a4_hz: result.tuning_estimate.map(|t| t.reference_a4_hz()),
        notes,
        warnings: result.warnings,
        raw_note_count: result.raw_note_count,
        refined_onsets: result.refine_stats.adjusted,
        dropped_pre_echoes: result.refine_stats.dropped,
        midi: result.midi,
    }
}

// ─── Exported API ───────────────────────────────────────────────────────────

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
    let _ = console_log::init_with_level(log::Level::Info);
}

/// Sample rate expected by [`transcribe`] (22050 Hz).
#[wasm_bindgen]
pub fn transcription_sample_rate() -> u32 {
    SAMPLE_RATE
}

/// Download URL of the HTDemucs weights used by [`separate_bass`].
#[wasm_bindgen]
pub fn separation_weights_url() -> String {
    metadata::download_url(&HTDEMUCS)
}

/// Approximate size of the HTDemucs weights, in megabytes.
#[wasm_bindgen]
pub fn separation_weights_size_mb() -> u32 {
    HTDEMUCS.size_mb
}

/// Separates the bass from a stereo mix with HTDemucs on WebGPU.
///
/// Returns the bass stem as `[left..., right...]` (two equal halves) at
/// `sample_rate`. `on_progress(done, total)` is called after each ~8 s chunk.
#[wasm_bindgen]
pub async fn separate_bass(
    weights: &[u8],
    left: &[f32],
    right: &[f32],
    sample_rate: u32,
    on_progress: Option<js_sys::Function>,
) -> Result<Vec<f32>, JsError> {
    let device = webgpu_device().await;
    log::info!("Loading HTDemucs ({} MB)", weights.len() / 1_000_000);
    let model = Demucs::<Backend>::from_bytes(ModelOptions::FourStem, weights, device).map_err(js_error)?;

    log::info!("Separating {:.1} s of audio at {} Hz", left.len() as f64 / f64::from(sample_rate), sample_rate);
    let mut listener = ChunkProgress { callback: on_progress };
    let stems = model.separate_with_listener(left, right, sample_rate, &mut listener).await.map_err(js_error)?;
    let bass = stems
        .into_iter()
        .find(|stem| stem.id == StemId::Bass)
        .ok_or_else(|| JsError::new("Demucs returned no bass stem"))?;

    let mut interleaved_halves = bass.left;
    interleaved_halves.extend_from_slice(&bass.right);
    Ok(interleaved_halves)
}

/// Transcribes mono bass audio at [`transcription_sample_rate`] into tablature.
///
/// `options`: `{ tuning, frets?, bpm?, onsetThreshold?, frameThreshold?,
/// minNoteMs?, barsPerLine? }`. `on_progress(done, total)` reports model progress.
#[wasm_bindgen]
pub fn transcribe(
    samples: &[f32],
    options: JsValue,
    on_progress: Option<js_sys::Function>,
) -> Result<JsValue, JsError> {
    let options: JsOptions = serde_wasm_bindgen::from_value(options).map_err(js_error)?;
    let options = options.into_options().map_err(js_error)?;
    let model = basic_pitch()?;

    let mut progress = |done: usize, total: usize| {
        if let Some(callback) = &on_progress {
            let _ = callback.call2(&JsValue::NULL, &JsValue::from(done as u32), &JsValue::from(total as u32));
        }
    };
    let result = pipeline::transcribe(&model, samples, &options, &mut progress).map_err(js_error)?;
    let js_result = to_js_transcription(result, &options.tuning);
    serde_wasm_bindgen::to_value(&js_result).map_err(js_error)
}
