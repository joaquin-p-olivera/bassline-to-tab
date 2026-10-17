//! Note names, MIDI pitch helpers and bass tuning definitions.

use anyhow::{bail, Context, Result};

const SHARP_NAMES: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/// Formats a MIDI pitch as scientific pitch notation, e.g. `28 -> "E1"`.
pub fn pitch_name(pitch: u8) -> String {
    let octave = i32::from(pitch) / 12 - 1;
    format!("{}{}", SHARP_NAMES[usize::from(pitch % 12)], octave)
}

/// Parses scientific pitch notation (`E1`, `Eb1`, `F#2`, `bb0`) into a MIDI pitch.
pub fn parse_pitch(name: &str) -> Result<u8> {
    let name = name.trim();
    let mut chars = name.chars();
    let letter = chars.next().context("empty note name")?;
    let mut semitone: i32 = match letter.to_ascii_uppercase() {
        'C' => 0,
        'D' => 2,
        'E' => 4,
        'F' => 5,
        'G' => 7,
        'A' => 9,
        'B' => 11,
        other => bail!("invalid note letter '{other}' in '{name}'"),
    };
    let rest: String = chars.collect();
    let octave_start = rest
        .find(|c: char| c.is_ascii_digit() || c == '-')
        .with_context(|| format!("missing octave number in '{name}'"))?;
    let (accidentals, octave) = rest.split_at(octave_start);
    for accidental in accidentals.chars() {
        match accidental {
            '#' => semitone += 1,
            'b' => semitone -= 1,
            other => bail!("invalid accidental '{other}' in '{name}'"),
        }
    }
    let octave: i32 = octave.parse().with_context(|| format!("invalid octave '{octave}' in '{name}'"))?;
    let pitch = (octave + 1) * 12 + semitone;
    u8::try_from(pitch).ok().filter(|p| *p <= 127).with_context(|| format!("note '{name}' is outside the MIDI range"))
}

/// Open-string pitches of a bass, ordered from the lowest string to the highest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tuning {
    strings: Vec<u8>,
}

impl Tuning {
    /// Builds a tuning from a preset name or a list of notes such as `"E1 A1 D2 G2"`.
    pub fn from_spec(spec: &str) -> Result<Self> {
        let preset = match spec.trim().to_ascii_lowercase().as_str() {
            "standard" | "e-standard" => Some("E1 A1 D2 G2"),
            "drop-d" => Some("D1 A1 D2 G2"),
            "half-step-down" | "eb-standard" => Some("Eb1 Ab1 Db2 Gb2"),
            "d-standard" => Some("D1 G1 C2 F2"),
            "five-string" => Some("B0 E1 A1 D2 G2"),
            "six-string" => Some("B0 E1 A1 D2 G2 C3"),
            _ => None,
        };
        let notes = preset.unwrap_or(spec);
        let strings = notes
            .split(|c: char| c.is_whitespace() || c == ',')
            .filter(|token| !token.is_empty())
            .map(parse_pitch)
            .collect::<Result<Vec<u8>>>()
            .with_context(|| format!("invalid tuning '{spec}'"))?;
        Self::new(strings)
    }

    /// Builds a tuning from open-string MIDI pitches, lowest string first.
    pub fn new(strings: Vec<u8>) -> Result<Self> {
        if strings.is_empty() {
            bail!("a tuning needs at least one string");
        }
        if strings.windows(2).any(|pair| pair[0] >= pair[1]) {
            bail!("strings must be listed from lowest to highest pitch");
        }
        Ok(Self { strings })
    }

    pub fn strings(&self) -> &[u8] {
        &self.strings
    }

    pub fn lowest(&self) -> u8 {
        self.strings[0]
    }

    pub fn highest_open(&self) -> u8 {
        self.strings[self.strings.len() - 1]
    }

    /// Short label for a string in the tab header, e.g. `"E"` or `"Eb"`.
    pub fn label(&self, string: usize) -> String {
        let name = pitch_name(self.strings[string]);
        name.trim_end_matches(|c: char| c.is_ascii_digit() || c == '-').to_string()
    }

    /// Human-readable description, e.g. `"E1 A1 D2 G2"`.
    pub fn describe(&self) -> String {
        self.strings.iter().map(|p| pitch_name(*p)).collect::<Vec<_>>().join(" ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_formats_pitches() {
        assert_eq!(parse_pitch("E1").unwrap(), 28);
        assert_eq!(parse_pitch("A4").unwrap(), 69);
        assert_eq!(parse_pitch("Eb1").unwrap(), 27);
        assert_eq!(parse_pitch("f#2").unwrap(), 42);
        assert_eq!(parse_pitch("B0").unwrap(), 23);
        assert_eq!(pitch_name(28), "E1");
        assert_eq!(pitch_name(27), "D#1");
        assert!(parse_pitch("H2").is_err());
        assert!(parse_pitch("E").is_err());
    }

    #[test]
    fn resolves_presets_and_custom_tunings() {
        assert_eq!(Tuning::from_spec("standard").unwrap().strings(), &[28, 33, 38, 43]);
        assert_eq!(Tuning::from_spec("drop-d").unwrap().strings(), &[26, 33, 38, 43]);
        assert_eq!(Tuning::from_spec("five-string").unwrap().strings(), &[23, 28, 33, 38, 43]);
        assert_eq!(Tuning::from_spec("E1, A1, D2, G2").unwrap().strings(), &[28, 33, 38, 43]);
        assert!(Tuning::from_spec("G2 D2 A1 E1").is_err());
    }

    #[test]
    fn labels_strings_without_octave() {
        let tuning = Tuning::from_spec("half-step-down").unwrap();
        assert_eq!(tuning.label(0), "D#");
        assert_eq!(Tuning::from_spec("standard").unwrap().label(3), "G");
    }
}
