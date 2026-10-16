//! Validation of the transcription options sent by the web form.

use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use bassline_to_tab::tuning::Tuning;

/// Audio formats accepted for upload (what Symphonia and Demucs can both read).
const ALLOWED_EXTENSIONS: [&str; 6] = ["wav", "mp3", "flac", "ogg", "m4a", "aac"];

const MIN_BPM: f64 = 30.0;
const MAX_BPM: f64 = 300.0;
const MIN_FRETS: u8 = 12;
const MAX_FRETS: u8 = 36;
const MAX_TUNING_LEN: usize = 100;

/// Options of one transcription job; mirrors the relevant CLI flags.
#[derive(Debug, Clone, PartialEq)]
pub struct JobOptions {
    pub tuning: String,
    pub frets: u8,
    pub bpm: Option<f64>,
    pub separate: bool,
}

impl Default for JobOptions {
    fn default() -> Self {
        Self { tuning: "standard".to_string(), frets: 24, bpm: None, separate: true }
    }
}

impl JobOptions {
    /// Applies one multipart form field. Unknown fields are ignored.
    pub fn set_field(&mut self, name: &str, value: &str) -> Result<()> {
        let value = value.trim();
        match name {
            "tuning" => {
                if value.len() > MAX_TUNING_LEN {
                    bail!("the tuning is too long");
                }
                Tuning::from_spec(value)?;
                self.tuning = value.to_string();
            }
            "frets" => {
                let frets: u8 = value.parse().context("must be a whole number")?;
                if !(MIN_FRETS..=MAX_FRETS).contains(&frets) {
                    bail!("must be between {MIN_FRETS} and {MAX_FRETS}");
                }
                self.frets = frets;
            }
            "bpm" => {
                self.bpm = if value.is_empty() {
                    None
                } else {
                    let bpm: f64 = value.parse().context("must be a number")?;
                    if !bpm.is_finite() || !(MIN_BPM..=MAX_BPM).contains(&bpm) {
                        bail!("must be between {MIN_BPM} and {MAX_BPM}");
                    }
                    Some(bpm)
                };
            }
            "separate" => {
                self.separate = match value {
                    "true" => true,
                    "false" => false,
                    _ => bail!("must be true or false"),
                };
            }
            _ => {}
        }
        Ok(())
    }
}

/// Returns the lowercase extension of an uploaded file if it is an accepted audio format.
pub fn audio_extension(file_name: &str) -> Result<&'static str> {
    let extension = Path::new(file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    ALLOWED_EXTENSIONS
        .iter()
        .find(|allowed| **allowed == extension)
        .copied()
        .ok_or_else(|| anyhow!("unsupported audio format; use one of: {}", ALLOWED_EXTENSIONS.join(", ")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_a_standard_four_string_with_separation() {
        let options = JobOptions::default();
        assert_eq!(options.tuning, "standard");
        assert_eq!(options.frets, 24);
        assert_eq!(options.bpm, None);
        assert!(options.separate);
    }

    #[test]
    fn accepts_valid_fields() {
        let mut options = JobOptions::default();
        options.set_field("tuning", "drop-d").unwrap();
        options.set_field("frets", "21").unwrap();
        options.set_field("bpm", "96.5").unwrap();
        options.set_field("separate", "false").unwrap();
        assert_eq!(
            options,
            JobOptions { tuning: "drop-d".to_string(), frets: 21, bpm: Some(96.5), separate: false }
        );
    }

    #[test]
    fn empty_bpm_means_estimate_it() {
        let mut options = JobOptions { bpm: Some(100.0), ..JobOptions::default() };
        options.set_field("bpm", "  ").unwrap();
        assert_eq!(options.bpm, None);
    }

    #[test]
    fn rejects_out_of_range_values() {
        let mut options = JobOptions::default();
        assert!(options.set_field("bpm", "5").is_err());
        assert!(options.set_field("bpm", "NaN").is_err());
        assert!(options.set_field("bpm", "fast").is_err());
        assert!(options.set_field("frets", "2").is_err());
        assert!(options.set_field("frets", "-1").is_err());
        assert!(options.set_field("separate", "maybe").is_err());
    }

    #[test]
    fn rejects_invalid_tunings() {
        let mut options = JobOptions::default();
        assert!(options.set_field("tuning", "--help").is_err());
        assert!(options.set_field("tuning", "not a tuning").is_err());
        assert!(options.set_field("tuning", &"E1 ".repeat(100)).is_err());
    }

    #[test]
    fn ignores_unknown_fields() {
        let mut options = JobOptions::default();
        options.set_field("surprise", "value").unwrap();
        assert_eq!(options, JobOptions::default());
    }

    #[test]
    fn audio_extension_is_case_insensitive_and_whitelisted() {
        assert_eq!(audio_extension("Song.MP3").unwrap(), "mp3");
        assert_eq!(audio_extension("a.b.flac").unwrap(), "flac");
        assert!(audio_extension("notes.txt").is_err());
        assert!(audio_extension("no_extension").is_err());
        assert!(audio_extension("").is_err());
    }
}
