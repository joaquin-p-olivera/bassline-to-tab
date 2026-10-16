//! Basic Pitch inference with tract.
//!
//! The model (`models/basic_pitch_nmp.onnx`) is Spotify's Basic Pitch
//! ICASSP 2022 model, Apache-2.0 licensed, embedded in the binary. It takes
//! mono audio at 22.05 kHz in ~2 s windows and returns three posteriorgrams:
//! note activations, onset activations (88 piano keys each) and a pitch
//! contour with 3 bins per semitone.

use std::io::Cursor;

use anyhow::{Context, Result};
use log::{debug, info};
use tract_onnx::prelude::*;

static MODEL_BYTES: &[u8] = include_bytes!("../models/basic_pitch_nmp.onnx");

pub const SAMPLE_RATE: u32 = 22_050;
/// MIDI pitch of the first model bin (A0).
pub const MIDI_OFFSET: u8 = 21;
pub const N_PITCHES: usize = 88;
pub const CONTOUR_BINS_PER_SEMITONE: usize = 3;

const FFT_HOP: usize = 256;
const WINDOW_SAMPLES: usize = 2 * SAMPLE_RATE as usize - FFT_HOP;
const WINDOW_FRAMES: usize = 172;
const OVERLAP_FRAMES: usize = 30;
const OVERLAP_SAMPLES: usize = OVERLAP_FRAMES * FFT_HOP;
const HOP_SAMPLES: usize = WINDOW_SAMPLES - OVERLAP_SAMPLES;
/// Frame rate used by Basic Pitch to size its output (integer division on purpose).
const FRAMES_PER_SECOND: usize = SAMPLE_RATE as usize / FFT_HOP;
/// Model output tensors, in the order (note, onset, contour).
const OUTPUT_NAMES: [&str; 3] = ["StatefulPartitionedCall:1", "StatefulPartitionedCall:2", "StatefulPartitionedCall:0"];

/// Dense row-major matrix of model activations: one row per frame.
#[derive(Clone, Debug, PartialEq)]
pub struct Grid {
    rows: usize,
    cols: usize,
    data: Vec<f32>,
}

impl Grid {
    pub fn zeros(rows: usize, cols: usize) -> Self {
        Self { rows, cols, data: vec![0.0; rows * cols] }
    }

    pub fn from_vec(rows: usize, cols: usize, data: Vec<f32>) -> Self {
        assert_eq!(data.len(), rows * cols, "grid data does not match its shape");
        Self { rows, cols, data }
    }

    pub fn rows(&self) -> usize {
        self.rows
    }

    pub fn cols(&self) -> usize {
        self.cols
    }

    pub fn get(&self, row: usize, col: usize) -> f32 {
        self.data[row * self.cols + col]
    }

    pub fn set(&mut self, row: usize, col: usize, value: f32) {
        self.data[row * self.cols + col] = value;
    }

    pub fn max(&self) -> f32 {
        self.data.iter().copied().fold(0.0, f32::max)
    }
}

/// Model output for a whole recording.
#[derive(Clone, Debug)]
pub struct Posteriorgram {
    /// Note activations, `frames x 88`.
    pub notes: Grid,
    /// Onset activations, `frames x 88`.
    pub onsets: Grid,
    /// Pitch contour, `frames x 264` (3 bins per semitone).
    pub contours: Grid,
    /// Time in seconds of each frame.
    pub frame_times: Vec<f64>,
}

/// Loaded, optimized Basic Pitch model.
pub struct BasicPitch {
    plan: std::sync::Arc<TypedRunnableModel>,
}

impl BasicPitch {
    /// Loads the embedded model and optimizes it for a fixed window size.
    pub fn load() -> Result<Self> {
        let mut model = tract_onnx::onnx()
            .model_for_read(&mut Cursor::new(MODEL_BYTES))
            .context("failed to parse the embedded Basic Pitch model")?
            .with_input_fact(0, f32::fact([1, WINDOW_SAMPLES, 1]).into())?;
        let outputs = OUTPUT_NAMES
            .iter()
            .map(|name| model.find_outlet_label(name).with_context(|| format!("model output '{name}' not found")))
            .collect::<Result<Vec<_>>>()?;
        model.select_output_outlets(&outputs)?;
        let plan = model.into_optimized()?.into_runnable()?;
        debug!("Basic Pitch model loaded ({} bytes)", MODEL_BYTES.len());
        Ok(Self { plan })
    }

    /// Runs the model over mono audio sampled at [`SAMPLE_RATE`].
    ///
    /// Consecutive windows overlap by 30 frames. Basic Pitch cuts each
    /// window in the middle of the overlap, which leaves a step in the
    /// activations at every window boundary (and a fake onset when a note
    /// starts nearby). Here the overlapping frames are cross-faded instead.
    pub fn run(&self, audio: &[f32]) -> Result<Posteriorgram> {
        let mut padded = vec![0.0f32; OVERLAP_SAMPLES / 2];
        padded.extend_from_slice(audio);

        let n_windows = padded.len().div_ceil(HOP_SAMPLES).max(1);
        info!(
            "Running Basic Pitch on {:.1} s of audio ({} windows)",
            audio.len() as f64 / f64::from(SAMPLE_RATE),
            n_windows
        );

        let advance = WINDOW_FRAMES - OVERLAP_FRAMES;
        let n_slots = n_windows * advance + OVERLAP_FRAMES;
        let mut accumulators = [
            Grid::zeros(n_slots, N_PITCHES),
            Grid::zeros(n_slots, N_PITCHES),
            Grid::zeros(n_slots, N_PITCHES * CONTOUR_BINS_PER_SEMITONE),
        ];
        let mut weights = vec![0.0f32; n_slots];

        for window_index in 0..n_windows {
            let start = window_index * HOP_SAMPLES;
            let end = (start + WINDOW_SAMPLES).min(padded.len());
            let mut window = vec![0.0f32; WINDOW_SAMPLES];
            if start < end {
                window[..end - start].copy_from_slice(&padded[start..end]);
            }
            let input: Tensor = tract_ndarray::Array3::from_shape_vec((1, WINDOW_SAMPLES, 1), window)?.into();
            let outputs = self.plan.run(tvec!(input.into()))?;

            let first_slot = window_index * advance;
            for (accumulator, output) in accumulators.iter_mut().zip(outputs.iter()) {
                let view = output.to_plain_array_view::<f32>()?;
                let flat = view.as_slice().context("model output is not contiguous")?;
                let cols = accumulator.cols();
                for local in 0..WINDOW_FRAMES {
                    let weight = crossfade_weight(local);
                    let row = &flat[local * cols..(local + 1) * cols];
                    for (col, value) in row.iter().enumerate() {
                        let slot = first_slot + local;
                        accumulator.set(slot, col, accumulator.get(slot, col) + weight * value);
                    }
                }
            }
            for local in 0..WINDOW_FRAMES {
                weights[first_slot + local] += crossfade_weight(local);
            }
            if (window_index + 1) % 20 == 0 {
                debug!("Processed {}/{} windows", window_index + 1, n_windows);
            }
        }

        // Slot `OVERLAP_FRAMES / 2` is the first frame of real audio (the rest is padding).
        let first_slot = OVERLAP_FRAMES / 2;
        let n_frames = (audio.len() * FRAMES_PER_SECOND / SAMPLE_RATE as usize).min(n_slots - first_slot);
        let [notes, onsets, contours] =
            accumulators.map(|accumulator| normalize_rows(&accumulator, &weights, first_slot, n_frames));
        let frame_times = (0..n_frames).map(|frame| frame_time(first_slot + frame)).collect();
        debug!("Posteriorgram has {n_frames} frames");

        Ok(Posteriorgram { notes, onsets, contours, frame_times })
    }
}

/// Frames at the very edge of a window are ignored; the next ones fade in.
const EDGE_FRAMES: usize = 5;
const FADE_FRAMES: usize = OVERLAP_FRAMES - 2 * EDGE_FRAMES;
/// Keeps frames covered by a single window usable at the start and end of the audio.
const MIN_WEIGHT: f32 = 1e-3;

/// Weight of a window-local frame; fade-ins and fade-outs of consecutive
/// windows add up to 1 over the overlap.
fn crossfade_weight(local: usize) -> f32 {
    let fade_in = (local as f32 - EDGE_FRAMES as f32) / FADE_FRAMES as f32;
    let fade_out = ((WINDOW_FRAMES - EDGE_FRAMES) as f32 - local as f32) / FADE_FRAMES as f32;
    fade_in.min(fade_out).clamp(0.0, 1.0).max(MIN_WEIGHT)
}

fn normalize_rows(accumulator: &Grid, weights: &[f32], first_slot: usize, n_frames: usize) -> Grid {
    let mut grid = Grid::zeros(n_frames, accumulator.cols());
    for frame in 0..n_frames {
        let slot = first_slot + frame;
        for col in 0..accumulator.cols() {
            grid.set(frame, col, accumulator.get(slot, col) / weights[slot]);
        }
    }
    grid
}

/// Time in seconds of an output slot. Window `w` starts at padded sample
/// `w * HOP_SAMPLES`; within a window frames are `WINDOW_SAMPLES / WINDOW_FRAMES`
/// samples apart.
fn frame_time(slot: usize) -> f64 {
    let advance = WINDOW_FRAMES - OVERLAP_FRAMES;
    let (window, local) = (slot / advance, slot % advance);
    let samples_per_frame = WINDOW_SAMPLES as f64 / WINDOW_FRAMES as f64;
    let sample = (window * HOP_SAMPLES) as f64 + local as f64 * samples_per_frame - (OVERLAP_SAMPLES / 2) as f64;
    (sample / f64::from(SAMPLE_RATE)).max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crossfade_weights_sum_to_one_over_the_overlap() {
        let advance = WINDOW_FRAMES - OVERLAP_FRAMES;
        for local in 0..OVERLAP_FRAMES {
            let total = crossfade_weight(local) + crossfade_weight(local + advance);
            assert!((total - 1.0).abs() < 2.0 * MIN_WEIGHT, "local {local}: {total}");
        }
        assert_eq!(crossfade_weight(WINDOW_FRAMES / 2), 1.0);
    }

    #[test]
    fn frame_times_start_at_zero_and_advance_steadily() {
        assert!(frame_time(OVERLAP_FRAMES / 2) < 0.001);
        let one_window_later = frame_time(OVERLAP_FRAMES / 2 + WINDOW_FRAMES - OVERLAP_FRAMES);
        assert!((one_window_later - HOP_SAMPLES as f64 / f64::from(SAMPLE_RATE)).abs() < 0.002);
    }
}
