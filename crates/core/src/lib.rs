//! bassline-core: transcribe a bass line into bass tablature.
//!
//! Platform-agnostic: it takes mono samples at [`model::SAMPLE_RATE`] and
//! returns notes, tempo, tuning and an ASCII tab. Audio decoding and bass
//! separation happen in the caller (the browser, see `crates/web`).
//!
//! Pipeline: Basic Pitch model → note decoding → monophonic line → onset
//! refinement → tuning/tempo analysis → fret assignment → ASCII tab / MIDI.

pub mod analysis;
pub mod fretboard;
pub mod midi;
pub mod model;
pub mod notes;
pub mod onsets;
pub mod pipeline;
pub mod tab;
pub mod tuning;
