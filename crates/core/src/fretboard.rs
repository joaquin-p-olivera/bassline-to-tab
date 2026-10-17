//! Mapping pitches to string/fret positions on the bass neck.
//!
//! Positions are chosen for the whole note sequence at once with the Viterbi
//! algorithm (dynamic programming): among all possible fingerings, it finds
//! the one with the lowest total cost, where cost models how a bassist plays
//! (stay in one hand position, prefer the lower part of the neck, avoid big
//! jumps and unnecessary string crossings). A greedy note-by-note choice
//! cannot recover once the hand drifts up the neck; this can.

use crate::tuning::Tuning;

/// A place on the neck. `string` 0 is the lowest-pitched string.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Position {
    pub string: usize,
    pub fret: u8,
}

/// Frets the hand covers without moving ("one finger per fret").
const HAND_SPAN: u8 = 3;
/// Cost per fret the hand has to shift beyond its span.
const SHIFT_COST: f32 = 1.0;
/// Small cost per fret of any movement, so closer positions win ties.
const MOVE_COST: f32 = 0.1;
/// Cost for every string crossed between consecutive notes.
const STRING_CROSS_COST: f32 = 0.3;
/// Flat cost of an open string (no hand needed, but less control).
const OPEN_STRING_COST: f32 = 0.3;

/// How the bassist is assumed to play when a pitch fits on several strings.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FingeringStyle {
    /// Low frets and open strings, minimal hand movement.
    #[default]
    OpenPosition,
    /// Thicker strings (E/A) even if it means playing higher up the neck,
    /// as in many rock and metal riffs.
    LowerStrings,
}

impl FingeringStyle {
    /// Parses `"open-position"` or `"lower-strings"`.
    pub fn from_spec(spec: &str) -> anyhow::Result<Self> {
        match spec.trim().to_ascii_lowercase().as_str() {
            "open-position" | "open" => Ok(Self::OpenPosition),
            "lower-strings" | "low" => Ok(Self::LowerStrings),
            other => anyhow::bail!("unknown fingering style {other:?} (expected open-position or lower-strings)"),
        }
    }

    fn weights(self) -> Weights {
        match self {
            Self::OpenPosition => Weights { height: 0.08, high_fret: 0.3, string: 0.0 },
            // A step up one string must cost more than the five frets it saves,
            // and riffs on the E string often reach past the 12th fret.
            Self::LowerStrings => Weights { height: 0.03, high_fret: 0.15, string: 0.5 },
        }
    }
}

/// Style-dependent part of the position cost.
#[derive(Clone, Copy, Debug)]
struct Weights {
    /// Cost per fret number: how much the lower part of the neck is preferred.
    height: f32,
    /// Extra cost per fret above the 12th.
    high_fret: f32,
    /// Cost per string index above the lowest string.
    string: f32,
}

/// All positions where `pitch` can be played, given the tuning and number of frets.
pub fn candidate_positions(pitch: u8, tuning: &Tuning, max_fret: u8) -> Vec<Position> {
    tuning
        .strings()
        .iter()
        .enumerate()
        .filter(|(_, open)| pitch >= **open && pitch - **open <= max_fret)
        .map(|(string, open)| Position { string, fret: pitch - open })
        .collect()
}

/// Shifts `pitch` by whole octaves until it is playable. Returns `None` if
/// the instrument cannot play that pitch class at all (should not happen with
/// at least 12 frets).
pub fn fit_to_range(pitch: u8, tuning: &Tuning, max_fret: u8) -> Option<u8> {
    let lowest = tuning.lowest();
    let highest = tuning.highest_open().saturating_add(max_fret);
    let mut fitted = pitch;
    while fitted < lowest {
        fitted += 12;
    }
    while fitted > highest {
        fitted = fitted.checked_sub(12)?;
    }
    (fitted >= lowest).then_some(fitted)
}

fn position_cost(position: Position, weights: Weights) -> f32 {
    let string = weights.string * position.string as f32;
    if position.fret == 0 {
        return OPEN_STRING_COST + string;
    }
    let fret = f32::from(position.fret);
    string + weights.height * fret + weights.high_fret * (fret - 12.0).max(0.0)
}

/// Cost of playing `to` right after `from`. Open strings do not move the hand.
fn transition_cost(from: Position, to: Position) -> f32 {
    let strings = STRING_CROSS_COST * from.string.abs_diff(to.string) as f32;
    if from.fret == 0 || to.fret == 0 {
        return strings;
    }
    let distance = from.fret.abs_diff(to.fret);
    let shift = SHIFT_COST * f32::from(distance.saturating_sub(HAND_SPAN));
    strings + shift + MOVE_COST * f32::from(distance)
}

/// Assigns a position to every pitch, minimizing the total fingering cost
/// over the whole sequence. Pitches that cannot be played get `None` and
/// do not affect their neighbours.
pub fn assign_positions(pitches: &[u8], tuning: &Tuning, max_fret: u8, style: FingeringStyle) -> Vec<Option<Position>> {
    let weights = style.weights();
    let candidates: Vec<Vec<Position>> = pitches.iter().map(|p| candidate_positions(*p, tuning, max_fret)).collect();
    let playable: Vec<usize> = (0..pitches.len()).filter(|i| !candidates[*i].is_empty()).collect();
    let mut result = vec![None; pitches.len()];
    let Some(&first) = playable.first() else {
        return result;
    };

    // costs[k][j]: cheapest total cost ending at candidate j of the k-th playable note.
    // back[k][j]: which candidate of the previous playable note that path came from.
    let mut costs: Vec<Vec<f32>> = vec![candidates[first].iter().map(|p| position_cost(*p, weights)).collect()];
    let mut back: Vec<Vec<usize>> = vec![vec![0; candidates[first].len()]];
    for window in playable.windows(2) {
        let (previous, current) = (&candidates[window[0]], &candidates[window[1]]);
        let previous_costs = costs.last().expect("at least one step");
        let (mut step_costs, mut step_back) = (Vec::with_capacity(current.len()), Vec::with_capacity(current.len()));
        for to in current {
            let (best_from, best_cost) = previous
                .iter()
                .enumerate()
                .map(|(i, from)| (i, previous_costs[i] + transition_cost(*from, *to)))
                .min_by(|a, b| a.1.total_cmp(&b.1))
                .expect("candidates are non-empty");
            step_costs.push(best_cost + position_cost(*to, weights));
            step_back.push(best_from);
        }
        costs.push(step_costs);
        back.push(step_back);
    }

    // Walk back from the cheapest final position.
    let last_costs = costs.last().expect("at least one step");
    let mut choice = (0..last_costs.len()).min_by(|a, b| last_costs[*a].total_cmp(&last_costs[*b])).expect("non-empty");
    for (k, &note_index) in playable.iter().enumerate().rev() {
        result[note_index] = Some(candidates[note_index][choice]);
        choice = back[k][choice];
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn standard() -> Tuning {
        Tuning::from_spec("standard").unwrap()
    }

    #[test]
    fn lists_every_playable_position() {
        let tuning = standard();
        assert_eq!(candidate_positions(28, &tuning, 24), vec![Position { string: 0, fret: 0 }]);
        assert_eq!(
            candidate_positions(33, &tuning, 24),
            vec![Position { string: 0, fret: 5 }, Position { string: 1, fret: 0 }]
        );
        assert!(candidate_positions(27, &tuning, 24).is_empty());
    }

    #[test]
    fn shifts_out_of_range_pitches_by_octaves() {
        let tuning = standard();
        assert_eq!(fit_to_range(26, &tuning, 24), Some(38));
        // Highest playable note is G2 + 24 frets = G4 (67).
        assert_eq!(fit_to_range(80, &tuning, 24), Some(56));
        assert_eq!(fit_to_range(40, &tuning, 24), Some(40));
    }

    #[test]
    fn prefers_nearby_positions_and_open_strings() {
        // G1 A1 B1 C2: stays around the 3rd fret and uses the open A string.
        let tuning = standard();
        let positions = assign_positions(&[31, 33, 35, 36], &tuning, 24, FingeringStyle::OpenPosition);
        let frets: Vec<(usize, u8)> = positions.iter().map(|p| p.map(|p| (p.string, p.fret)).unwrap()).collect();
        assert_eq!(frets, vec![(0, 3), (1, 0), (1, 2), (1, 3)]);
    }

    #[test]
    fn returns_to_low_position_after_a_high_phrase() {
        // E3 E3 then a run of E2 G2 A2: the E2s belong at the bottom of the
        // neck, not 12 frets up where a greedy choice following the hand ends.
        let tuning = standard();
        let pitches = [52, 52, 40, 43, 45, 40, 43, 45, 40];
        let positions = assign_positions(&pitches, &tuning, 24, FingeringStyle::OpenPosition);
        for (pitch, position) in pitches.iter().zip(&positions).skip(2) {
            let position = position.unwrap();
            assert!(position.fret <= 7, "pitch {pitch} placed at {position:?}");
        }
    }

    #[test]
    fn skips_unplayable_notes_without_breaking_the_rest() {
        let tuning = standard();
        let positions = assign_positions(&[20, 28, 33], &tuning, 24, FingeringStyle::OpenPosition);
        assert_eq!(positions[0], None);
        assert_eq!(positions[1], Some(Position { string: 0, fret: 0 }));
        assert!(positions[2].is_some());
    }

    #[test]
    fn stays_in_position_across_strings() {
        // E2 A2 E2 is played on the 2nd fret of the D and G strings.
        let tuning = standard();
        let positions = assign_positions(&[40, 45, 40], &tuning, 24, FingeringStyle::OpenPosition);
        let frets: Vec<(usize, u8)> = positions.iter().map(|p| p.map(|p| (p.string, p.fret)).unwrap()).collect();
        assert_eq!(frets, vec![(2, 2), (3, 2), (2, 2)]);
    }

    fn strings_and_frets(positions: &[Option<Position>]) -> Vec<(usize, u8)> {
        positions.iter().map(|p| p.map(|p| (p.string, p.fret)).unwrap()).collect()
    }

    #[test]
    fn lower_strings_style_moves_up_the_neck() {
        // The same E2 A2 E2 played on the E and A strings at the 12th fret.
        let tuning = standard();
        let positions = assign_positions(&[40, 45, 40], &tuning, 24, FingeringStyle::LowerStrings);
        assert_eq!(strings_and_frets(&positions), vec![(0, 12), (1, 12), (0, 12)]);
    }

    #[test]
    fn lower_strings_style_keeps_a_riff_on_the_e_and_a_strings() {
        // E2 G2 A2 B2 E2: a rock riff, played around the 12th fret on E/A.
        let tuning = standard();
        let pitches = [40, 43, 45, 47, 40];
        let open = strings_and_frets(&assign_positions(&pitches, &tuning, 24, FingeringStyle::OpenPosition));
        let low = strings_and_frets(&assign_positions(&pitches, &tuning, 24, FingeringStyle::LowerStrings));
        assert!(open.iter().any(|(string, _)| *string >= 2), "open position uses the D/G strings: {open:?}");
        assert!(low.iter().all(|(string, _)| *string <= 1), "lower strings stays on E/A: {low:?}");
        assert!(low.iter().all(|(_, fret)| (10..=15).contains(fret)), "{low:?}");
    }

    #[test]
    fn lower_strings_style_still_uses_open_e() {
        let tuning = standard();
        let positions = assign_positions(&[28, 28, 31], &tuning, 24, FingeringStyle::LowerStrings);
        assert_eq!(strings_and_frets(&positions), vec![(0, 0), (0, 0), (0, 3)]);
    }

    #[test]
    fn parses_fingering_styles() {
        assert_eq!(FingeringStyle::from_spec("open-position").unwrap(), FingeringStyle::OpenPosition);
        assert_eq!(FingeringStyle::from_spec(" Lower-Strings ").unwrap(), FingeringStyle::LowerStrings);
        assert!(FingeringStyle::from_spec("sideways").is_err());
    }
}
