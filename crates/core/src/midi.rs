//! Standard MIDI file output.

use std::path::Path;

use anyhow::{Context, Result};
use midly::num::{u15, u24, u28, u4, u7};
use midly::{Format, Header, MetaMessage, MidiMessage, Smf, Timing, TrackEvent, TrackEventKind};

use crate::instrument::Instrument;
use crate::notes::Note;

const TICKS_PER_BEAT: u16 = 480;
const CHANNEL: u8 = 0;

fn seconds_to_ticks(seconds: f64, bpm: f64) -> u32 {
    (seconds * bpm / 60.0 * f64::from(TICKS_PER_BEAT)).round().max(0.0) as u32
}

fn velocity(amplitude: f32) -> u7 {
    u7::new((amplitude.clamp(0.0, 1.0) * 127.0).round().max(1.0) as u8)
}

fn midi_event(message: MidiMessage) -> TrackEventKind<'static> {
    TrackEventKind::Midi { channel: u4::new(CHANNEL), message }
}

/// Encodes notes as a single-track MIDI file (as bytes).
pub fn encode(notes: &[Note], bpm: f64, instrument: Instrument) -> Result<Vec<u8>> {
    // (tick, is_note_on, event); offs sort before ons at the same tick.
    let mut timed: Vec<(u32, bool, TrackEventKind<'static>)> = Vec::with_capacity(notes.len() * 2);
    for note in notes {
        let key = u7::new(note.pitch.min(127));
        let start = seconds_to_ticks(note.start, bpm);
        let end = seconds_to_ticks(note.end, bpm).max(start + 1);
        timed.push((start, true, midi_event(MidiMessage::NoteOn { key, vel: velocity(note.amplitude) })));
        timed.push((end, false, midi_event(MidiMessage::NoteOff { key, vel: u7::new(0) })));
    }
    timed.sort_by_key(|(tick, is_on, _)| (*tick, *is_on));

    let tempo_us = (60_000_000.0 / bpm).round() as u32;
    let mut track = vec![
        TrackEvent {
            delta: u28::new(0),
            kind: TrackEventKind::Meta(MetaMessage::TrackName(instrument.midi_track_name())),
        },
        TrackEvent { delta: u28::new(0), kind: TrackEventKind::Meta(MetaMessage::Tempo(u24::new(tempo_us))) },
        TrackEvent { delta: u28::new(0), kind: TrackEventKind::Meta(MetaMessage::TimeSignature(4, 2, 24, 8)) },
        TrackEvent {
            delta: u28::new(0),
            kind: midi_event(MidiMessage::ProgramChange { program: u7::new(instrument.midi_program()) }),
        },
    ];
    let mut previous_tick = 0;
    for (tick, _, kind) in timed {
        track.push(TrackEvent { delta: u28::new(tick - previous_tick), kind });
        previous_tick = tick;
    }
    track.push(TrackEvent { delta: u28::new(0), kind: TrackEventKind::Meta(MetaMessage::EndOfTrack) });

    let smf = Smf {
        header: Header::new(Format::SingleTrack, Timing::Metrical(u15::new(TICKS_PER_BEAT))),
        tracks: vec![track],
    };
    let mut bytes = Vec::new();
    smf.write_std(&mut bytes).context("failed to encode MIDI")?;
    Ok(bytes)
}

/// Writes notes to a MIDI file.
pub fn write(path: &Path, notes: &[Note], bpm: f64, instrument: Instrument) -> Result<()> {
    std::fs::write(path, encode(notes, bpm, instrument)?).with_context(|| format!("cannot write {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_notes_through_midi() {
        let notes = vec![
            Note { start: 0.0, end: 0.5, start_frame: 0, end_frame: 0, pitch: 28, amplitude: 1.0 },
            Note { start: 0.5, end: 1.0, start_frame: 0, end_frame: 0, pitch: 33, amplitude: 0.5 },
        ];
        let bytes = encode(&notes, 120.0, Instrument::Bass).unwrap();
        let smf = Smf::parse(&bytes).unwrap();
        let mut tick = 0u32;
        let mut ons = Vec::new();
        for event in &smf.tracks[0] {
            tick += event.delta.as_int();
            if let TrackEventKind::Midi { message: MidiMessage::NoteOn { key, vel }, .. } = event.kind {
                ons.push((tick, key.as_int(), vel.as_int()));
            }
        }
        assert_eq!(ons, vec![(0, 28, 127), (480, 33, 64)]);
    }
}
