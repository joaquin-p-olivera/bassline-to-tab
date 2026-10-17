"""Synthesize the test bass riff (harmonic tone with a pluck envelope) as a WAV file."""
import argparse
import logging
import wave

import numpy as np

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("make_bassline")

# (midi pitch, duration in eighth notes): an original two-bar riff in E, repeated.
RIFF = [(28, 2), (28, 1), (31, 1), (33, 2), (35, 1), (36, 1),
        (38, 2), (36, 1), (35, 1), (33, 2), (31, 1), (30, 1)]


def pluck(freq: float, seconds: float, sample_rate: int) -> np.ndarray:
    """Harmonic tone with a short attack and exponential decay."""
    t = np.arange(int(seconds * sample_rate)) / sample_rate
    tone = sum(np.sin(2 * np.pi * freq * h * t) / h**1.2 for h in range(1, 9) if freq * h < sample_rate / 2)
    envelope = np.minimum(t / 0.005, 1.0) * np.exp(-t * 3.0)
    release = np.minimum((seconds - t) / 0.01, 1.0)
    return tone * envelope * release


def render(bpm: float, cents: float, repeats: int, sample_rate: int, lead_in: float) -> np.ndarray:
    eighth = 60.0 / bpm / 2
    parts = [np.zeros(int(lead_in * sample_rate))]
    for _ in range(repeats):
        for pitch, length in RIFF:
            freq = 440.0 * 2 ** ((pitch - 69) / 12 + cents / 1200)
            parts.append(pluck(freq, length * eighth, sample_rate))
    parts.append(np.zeros(sample_rate))
    audio = np.concatenate(parts)
    return 0.5 * audio / np.max(np.abs(audio))


def write_wav(path: str, audio: np.ndarray, sample_rate: int, channels: int) -> None:
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    if channels == 2:
        pcm = np.stack([pcm, pcm], axis=1).reshape(-1)
    with wave.open(path, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm.tobytes())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output")
    parser.add_argument("--bpm", type=float, default=100.0)
    parser.add_argument("--cents", type=float, default=0.0)
    parser.add_argument("--repeats", type=int, default=4)
    parser.add_argument("--sample-rate", type=int, default=44100)
    parser.add_argument("--channels", type=int, default=2)
    parser.add_argument("--lead-in", type=float, default=0.5)
    args = parser.parse_args()
    audio = render(args.bpm, args.cents, args.repeats, args.sample_rate, args.lead_in)
    write_wav(args.output, audio, args.sample_rate, args.channels)
    logger.info("Wrote %s (%.1f s, %d Hz, %d ch, %+.0f cents)", args.output, len(audio) / args.sample_rate,
                args.sample_rate, args.channels, args.cents)


if __name__ == "__main__":
    main()
