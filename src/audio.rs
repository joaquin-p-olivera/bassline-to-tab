//! Audio decoding (any format symphonia supports) and resampling.

use std::fs::File;
use std::path::Path;

use anyhow::{bail, Context, Result};
use log::{debug, info};
use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Resampler};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

/// Decodes an audio file and downmixes it to mono. Returns samples and sample rate.
pub fn load_mono(path: &Path) -> Result<(Vec<f32>, u32)> {
    let file = File::open(path).with_context(|| format!("cannot open {}", path.display()))?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(extension);
    }

    let mut format = symphonia::default::get_probe()
        .probe(&hint, stream, FormatOptions::default(), MetadataOptions::default())
        .with_context(|| format!("unsupported or corrupt audio file {}", path.display()))?;
    let track = format.default_track(TrackType::Audio).context("no audio track found")?;
    let track_id = track.id;
    let codec_params =
        track.codec_params.as_ref().and_then(|params| params.audio()).context("track has no audio codec parameters")?;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(codec_params, &AudioDecoderOptions::default())
        .context("no decoder available for this audio codec")?;

    let mut mono = Vec::new();
    let mut interleaved: Vec<f32> = Vec::new();
    let mut sample_rate = 0;
    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            Err(SymphoniaError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(e).context("failed to read audio packet"),
        };
        if packet.track_id != track_id {
            continue;
        }
        let buffer = match decoder.decode(&packet) {
            Ok(buffer) => buffer,
            Err(SymphoniaError::DecodeError(e)) => {
                debug!("Skipping undecodable packet: {e}");
                continue;
            }
            Err(e) => return Err(e).context("failed to decode audio"),
        };
        let channels = buffer.spec().channels().count().max(1);
        sample_rate = buffer.spec().rate();
        interleaved.resize(buffer.samples_interleaved(), 0.0);
        buffer.copy_to_slice_interleaved(&mut interleaved);
        mono.extend(interleaved.chunks(channels).map(|frame| frame.iter().sum::<f32>() / channels as f32));
    }

    if mono.is_empty() || sample_rate == 0 {
        bail!("no audio could be decoded from {}", path.display());
    }
    info!("Decoded {} ({:.1} s at {} Hz)", path.display(), mono.len() as f64 / f64::from(sample_rate), sample_rate);
    Ok((mono, sample_rate))
}

/// Resamples mono audio from `from_rate` to `to_rate`.
pub fn resample(samples: &[f32], from_rate: u32, to_rate: u32) -> Result<Vec<f32>> {
    if from_rate == to_rate {
        return Ok(samples.to_vec());
    }
    debug!("Resampling {from_rate} Hz -> {to_rate} Hz");
    let mut resampler = Fft::<f32>::new(from_rate as usize, to_rate as usize, 1024, 1, FixedSync::Input)
        .context("failed to create resampler")?;
    let input = InterleavedSlice::new(samples, 1, samples.len()).context("invalid resampler input")?;
    let output = resampler.process_all(&input, samples.len(), None).context("resampling failed")?;
    Ok(output.take_data())
}

/// Loads an audio file as mono at the requested sample rate.
pub fn load_resampled(path: &Path, sample_rate: u32) -> Result<Vec<f32>> {
    let (samples, original_rate) = load_mono(path)?;
    resample(&samples, original_rate, sample_rate)
}
