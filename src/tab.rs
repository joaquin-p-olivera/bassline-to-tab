//! Rhythmic quantization and ASCII tablature rendering.

use std::collections::HashMap;

use crate::analysis::Tempo;
use crate::fretboard::Position;
use crate::notes::Note;
use crate::tuning::Tuning;

/// Sixteenth-note resolution, 4/4 time.
pub const STEPS_PER_BEAT: usize = 4;
pub const STEPS_PER_BAR: usize = 16;

/// One fretted note placed on the rhythmic grid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TabEvent {
    /// Sixteenth-note index from the start of the first bar.
    pub step: usize,
    pub position: Position,
}

/// Snaps a note start to the nearest sixteenth of the tempo grid.
pub fn quantize_step(note: &Note, tempo: &Tempo) -> usize {
    let step_seconds = tempo.beat_seconds() / STEPS_PER_BEAT as f64;
    ((note.start - tempo.origin) / step_seconds).round().max(0.0) as usize
}

/// Places notes with an assigned position on the grid. When two notes land
/// on the same step only the first one is kept.
pub fn build_events(notes: &[Note], positions: &[Option<Position>], tempo: &Tempo) -> Vec<TabEvent> {
    let mut events: Vec<TabEvent> = Vec::with_capacity(notes.len());
    for (note, position) in notes.iter().zip(positions) {
        let Some(position) = position else { continue };
        let step = quantize_step(note, tempo);
        if events.last().is_some_and(|last| last.step >= step) {
            continue;
        }
        events.push(TabEvent { step, position: *position });
    }
    events
}

fn bar_cell_width(bar: usize, events_by_step: &HashMap<usize, Position>) -> usize {
    let has_two_digit_fret = (bar * STEPS_PER_BAR..(bar + 1) * STEPS_PER_BAR)
        .filter_map(|step| events_by_step.get(&step))
        .any(|position| position.fret >= 10);
    if has_two_digit_fret {
        3
    } else {
        2
    }
}

/// Renders events as ASCII bass tab, highest string on top, wrapping every
/// `bars_per_line` bars. Each line block starts with the bar numbers.
pub fn render(events: &[TabEvent], tuning: &Tuning, bars_per_line: usize) -> String {
    let bars_per_line = bars_per_line.max(1);
    let events_by_step: HashMap<usize, Position> = events.iter().map(|e| (e.step, e.position)).collect();
    let n_bars = events.last().map(|e| e.step / STEPS_PER_BAR + 1).unwrap_or(1);
    let labels: Vec<String> = (0..tuning.strings().len()).map(|s| tuning.label(s)).collect();
    let label_width = labels.iter().map(String::len).max().unwrap_or(1);

    let mut blocks = Vec::new();
    for first_bar in (0..n_bars).step_by(bars_per_line) {
        let bars: Vec<usize> = (first_bar..(first_bar + bars_per_line).min(n_bars)).collect();
        let widths: Vec<usize> = bars.iter().map(|bar| bar_cell_width(*bar, &events_by_step)).collect();

        let mut lines = Vec::with_capacity(labels.len() + 1);
        let mut numbers = " ".repeat(label_width + 1);
        for (bar, width) in bars.iter().zip(&widths) {
            numbers.push_str(&format!("{:<w$}", bar + 1, w = width * STEPS_PER_BAR + 1));
        }
        lines.push(numbers.trim_end().to_string());

        for string in (0..labels.len()).rev() {
            let mut line = format!("{:<w$}|", labels[string], w = label_width);
            for (bar, width) in bars.iter().zip(&widths) {
                for step in bar * STEPS_PER_BAR..(bar + 1) * STEPS_PER_BAR {
                    let cell = match events_by_step.get(&step) {
                        Some(position) if position.string == string => position.fret.to_string(),
                        _ => String::new(),
                    };
                    line.push_str(&format!("{cell:-<width$}"));
                }
                line.push('|');
            }
            lines.push(line);
        }
        blocks.push(lines.join("\n"));
    }
    blocks.join("\n\n") + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(step: usize, string: usize, fret: u8) -> TabEvent {
        TabEvent { step, position: Position { string, fret } }
    }

    #[test]
    fn renders_a_single_bar() {
        let tuning = Tuning::from_spec("standard").unwrap();
        let events = [event(0, 0, 3), event(4, 1, 0), event(8, 1, 2), event(12, 2, 0)];
        let expected = [
            "  1",
            "G|--------------------------------|",
            "D|------------------------0-------|",
            "A|--------0-------2---------------|",
            "E|3-------------------------------|",
        ]
        .join("\n")
            + "\n";
        assert_eq!(render(&events, &tuning, 4), expected);
    }

    #[test]
    fn widens_bars_with_two_digit_frets_and_wraps_lines() {
        let tuning = Tuning::from_spec("standard").unwrap();
        let events = [event(0, 3, 12), event(16, 0, 5), event(32, 0, 7)];
        let tab = render(&events, &tuning, 2);
        let blocks: Vec<&str> = tab.trim_end().split("\n\n").collect();
        assert_eq!(blocks.len(), 2);
        let first_g_line = blocks[0].lines().nth(1).unwrap();
        assert!(first_g_line.starts_with("G|12-"));
        // Bar 1 uses 3-char cells, bar 2 uses 2-char cells.
        assert_eq!(first_g_line.len(), 2 + 48 + 1 + 32 + 1);
        assert!(blocks[1].starts_with("  3"));
    }

    #[test]
    fn quantizes_to_sixteenths_and_drops_collisions() {
        let tempo = Tempo { bpm: 120.0, origin: 0.1 };
        let note =
            |start: f64| Note { start, end: start + 0.1, start_frame: 0, end_frame: 0, pitch: 28, amplitude: 0.5 };
        let notes = [note(0.1), note(0.36), note(0.37), note(0.62)];
        let positions = vec![Some(Position { string: 0, fret: 0 }); 4];
        let steps: Vec<usize> = build_events(&notes, &positions, &tempo).iter().map(|e| e.step).collect();
        assert_eq!(steps, vec![0, 2, 4]);
    }
}
