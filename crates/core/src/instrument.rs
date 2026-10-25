//! The instrument being transcribed. Most of the pipeline is the same for
//! both; the differences are collected here.

/// What the audio contains.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Instrument {
    #[default]
    Bass,
    /// Electric guitar, transcribed one note at a time (riffs and solos).
    Guitar,
}

impl Instrument {
    /// The name used by [`Self::from_spec`] and the web page.
    pub fn as_spec(self) -> &'static str {
        match self {
            Self::Bass => "bass",
            Self::Guitar => "guitar",
        }
    }

    /// Parses `"bass"` or `"guitar"`.
    pub fn from_spec(spec: &str) -> anyhow::Result<Self> {
        match spec.trim().to_ascii_lowercase().as_str() {
            "bass" => Ok(Self::Bass),
            "guitar" => Ok(Self::Guitar),
            other => anyhow::bail!("unknown instrument {other:?} (expected bass or guitar)"),
        }
    }

    /// Lowercase name for messages.
    pub fn name(self) -> &'static str {
        self.as_spec()
    }

    /// Tuning preset used when none is given.
    pub fn default_tuning(self) -> &'static str {
        match self {
            Self::Bass => "standard",
            Self::Guitar => "guitar-standard",
        }
    }

    /// Whether to move notes down an octave when the model also sees the
    /// octave below. Calibrated on bass, where the model often reports the
    /// 2nd harmonic; on guitar it would turn real high notes into wrong ones.
    pub fn corrects_octaves(self) -> bool {
        self == Self::Bass
    }

    /// General MIDI program, zero-based.
    pub fn midi_program(self) -> u8 {
        match self {
            // Electric Bass (finger)
            Self::Bass => 33,
            // Electric Guitar (clean)
            Self::Guitar => 27,
        }
    }

    pub fn midi_track_name(self) -> &'static [u8] {
        match self {
            Self::Bass => b"Bass",
            Self::Guitar => b"Guitar",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_specs() {
        assert_eq!(Instrument::from_spec("Guitar").unwrap(), Instrument::Guitar);
        assert_eq!(Instrument::from_spec(Instrument::Bass.as_spec()).unwrap(), Instrument::Bass);
        assert!(Instrument::from_spec("ukulele").is_err());
    }
}
