//! bassline-to-tab: transcribe the bass line of a recording into bass tablature.
//!
//! Pipeline: decode audio → (optional) Demucs bass stem → Basic Pitch model →
//! note decoding → monophonic line → onset refinement → tuning/tempo
//! analysis → fret assignment → ASCII tab (and optionally MIDI).

pub mod analysis;
pub mod audio;
pub mod fretboard;
pub mod midi;
pub mod model;
pub mod notes;
pub mod onsets;
pub mod separation;
pub mod tab;
pub mod tuning;
