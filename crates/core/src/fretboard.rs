//! Mapping pitches to string/fret positions on the bass neck.
//!
//! The MVP uses a greedy assignment: each note picks the position closest to
//! where the fretting hand currently is. A natural next step is a Viterbi /
//! dynamic-programming search over the whole note sequence.

use crate::tuning::Tuning;

/// A place on the neck. `string` 0 is the lowest-pitched string.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Position {
    pub string: usize,
    pub fret: u8,
}

/// Cost added for every fret the hand has to move.
const SHIFT_COST: f32 = 1.0;
/// Cost added per fret number, so lower positions win ties.
const HEIGHT_COST: f32 = 0.1;
/// Cost added for every string crossed.
const STRING_CROSS_COST: f32 = 0.3;
/// Flat cost for an open string (no hand movement needed).
const OPEN_STRING_COST: f32 = 1.0;

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

fn transition_cost(candidate: Position, hand_fret: Option<u8>, previous_string: Option<usize>) -> f32 {
    let string_cost = previous_string.map(|s| STRING_CROSS_COST * s.abs_diff(candidate.string) as f32).unwrap_or(0.0);
    if candidate.fret == 0 {
        return OPEN_STRING_COST + string_cost;
    }
    let shift = hand_fret.map(|hand| SHIFT_COST * f32::from(hand.abs_diff(candidate.fret))).unwrap_or(0.0);
    shift + HEIGHT_COST * f32::from(candidate.fret) + string_cost
}

/// Greedily assigns a position to every pitch. Pitches that cannot be played
/// get `None`.
pub fn assign_positions(pitches: &[u8], tuning: &Tuning, max_fret: u8) -> Vec<Option<Position>> {
    let mut hand_fret: Option<u8> = None;
    let mut previous_string: Option<usize> = None;
    pitches
        .iter()
        .map(|pitch| {
            let best = candidate_positions(*pitch, tuning, max_fret).into_iter().min_by(|a, b| {
                transition_cost(*a, hand_fret, previous_string).total_cmp(&transition_cost(
                    *b,
                    hand_fret,
                    previous_string,
                ))
            })?;
            if best.fret > 0 {
                hand_fret = Some(best.fret);
            }
            previous_string = Some(best.string);
            Some(best)
        })
        .collect()
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
        let positions = assign_positions(&[31, 33, 35, 36], &tuning, 24);
        let frets: Vec<(usize, u8)> = positions.iter().map(|p| p.map(|p| (p.string, p.fret)).unwrap()).collect();
        assert_eq!(frets, vec![(0, 3), (1, 0), (1, 2), (1, 3)]);
    }

    #[test]
    fn stays_in_position_across_strings() {
        // E2 A2 E2 is played on the 2nd fret of the D and G strings.
        let tuning = standard();
        let positions = assign_positions(&[40, 45, 40], &tuning, 24);
        let frets: Vec<(usize, u8)> = positions.iter().map(|p| p.map(|p| (p.string, p.fret)).unwrap()).collect();
        assert_eq!(frets, vec![(2, 2), (3, 2), (2, 2)]);
    }
}
