# bassline-to-tab

Listen to a song, find the bass line, and write it out as bass tablature.

```
$ bassline-to-tab song.mp3 --tuning standard

song.mp3
Bass tuning: E1 A1 D2 G2 (standard)
Tempo: 100.0 BPM (estimated), 4/4
Recording tuning: A4 = 439.7 Hz (-1 cents)
Notes: 48

  1                                2
G|--------------------------------|--------------------------------|
D|--------------------------------|0-------------------------------|
A|----------------0-------2---3---|--------3---2---0---------------|
E|0-------0---3-------------------|------------------------3---2---|
```

(The example is the synthetic test riff from `tests/pipeline.rs`.)

## Status

MVP. It works well on clean, isolated bass lines and gives a useful first draft
on full mixes when Demucs is installed. Expect to fix things by hand: see
[Limitations](#limitations).

## How it works

```
audio file ─► Demucs (bass stem, optional) ─► decode + resample to 22.05 kHz
          ─► Basic Pitch model (ONNX, run with tract)
          ─► note decoding ─► monophonic line ─► onset refinement from the waveform
          ─► tuning + tempo estimation ─► fret assignment ─► ASCII tab / MIDI
```

| Step | Module | Notes |
| --- | --- | --- |
| Separation | `separation.rs` | Runs the external `demucs` CLI in two-stem mode. Optional. |
| Audio | `audio.rs` | Any format symphonia supports (wav, mp3, flac, ogg, m4a…), downmixed and resampled with rubato. |
| Model | `model.rs` | Spotify's [Basic Pitch](https://github.com/spotify/basic-pitch) ICASSP 2022 model, embedded in the binary (230 KB). Overlapping windows are cross-faded rather than hard-cut, which removes fake onsets at window boundaries. |
| Notes | `notes.rs` | Onset-peak tracking (ported from Basic Pitch), then reduced to one line: simultaneous notes keep the fundamental, overlaps are cut. |
| Onsets | `onsets.rs` | The model reports low notes late (up to ~50 ms on low E) and sometimes "pre-echoes" a note a sixteenth early. Each note start is snapped to the attack in the audio energy, and notes with no attack of their own are dropped. |
| Analysis | `analysis.rs` | Tuning reference from the pitch contour; tempo from onset autocorrelation, then a least-squares fit of the sixteenth grid so it does not drift over the song. |
| Fretboard | `fretboard.rs` | Greedy: each note takes the position closest to where the hand is, preferring open strings and lower frets. |
| Tab | `tab.rs` | Quantizes to sixteenths in 4/4 and renders ASCII tab. |
| MIDI | `midi.rs` | Optional `.mid` export of the detected notes. |

### Why Rust

The obvious choice was Python, but the `basic-pitch` package only supports
Python ≤ 3.11 and pulls in TensorFlow < 2.15 on Linux. Its wheel ships the
model as ONNX, which [tract](https://github.com/sonos/tract) runs in pure Rust
with no native dependencies. The result is a single binary with the model
inside. Demucs stays in Python because there is no practical Rust port; it is
called as an external command.

## Installation

Requires Rust 1.91+ (`rustup update` if needed).

```bash
git clone https://github.com/joaquin-p-olivera/bassline-to-tab
cd bassline-to-tab
cargo install --path .
```

The first build takes a few minutes (tract is large).

For full songs, install Demucs too (strongly recommended):

```bash
pipx install demucs     # or: pip install demucs
```

Demucs downloads its model weights (~80 MB) the first time it runs, and takes
roughly 1–3× the song length on CPU.

## Usage

```bash
# Full song: separates the bass with Demucs (if installed), then transcribes
bassline-to-tab song.mp3

# Already-isolated bass (a DI recording, a Demucs/Moises stem, ...)
bassline-to-tab bass.wav --no-separate

# Other tunings and instruments
bassline-to-tab song.flac --tuning drop-d
bassline-to-tab song.flac --tuning five-string
bassline-to-tab song.flac --tuning "D1 G1 C2 F2"

# Save the tab and a MIDI file; force the tempo
bassline-to-tab song.mp3 -o song.tab.txt --midi song.mid --bpm 128
```

Run `bassline-to-tab --help` for all options. Useful ones:

| Option | Default | Effect |
| --- | --- | --- |
| `--tuning` | `standard` | `standard`, `drop-d`, `half-step-down`, `d-standard`, `five-string`, `six-string`, or notes low → high. |
| `--frets` | 24 | Neck length. |
| `--bpm` | estimated | Use when the estimate is off (often by a factor of 2). |
| `--onset-threshold` | 0.5 | Lower to catch quiet notes; raise to drop false ones. |
| `--min-note-ms` | 80 | Shortest note kept. |
| `--demucs-cmd` | autodetect | e.g. `"python3 -m demucs"` inside a virtualenv. |
| `-v` / `-vv` | | Debug logging, including every raw note detected. |

## Web version

A small web server (`bassline-to-tab-server`) lets you upload a song from the
browser and shows the tab on the page, with downloads for the tab and the MIDI
file. It runs the CLI as a subprocess, one job at a time.

```bash
cargo run --release --features server --bin bassline-to-tab-server
# then open http://localhost:7860
```

It needs `bassline-to-tab` next to it (or in `PATH`) and, for full songs,
Demucs. Settings come from environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | 7860 | Port to listen on. |
| `MAX_UPLOAD_MB` | 50 | Largest accepted upload. |
| `MAX_QUEUE` | 4 | Jobs allowed to wait; more get a 503. |
| `JOB_TIMEOUT_SECS` | 3600 | A job running longer is killed. |
| `RESULT_TTL_SECS` | 3600 | How long a finished tab stays available. |
| `WORK_DIR` | system temp dir | Where uploads and results are stored. |
| `BASSLINE_CLI` | next to the server | Path of the `bassline-to-tab` executable. |

API: `POST /api/jobs` (multipart: `audio`, `tuning`, `frets`, `bpm`, `separate`)
returns `{"id": ...}`; `GET /api/jobs/{id}` returns the status and the tab;
`GET /api/jobs/{id}/midi` downloads the MIDI.

### Docker and Hugging Face Spaces

The `Dockerfile` builds both binaries and installs Demucs on CPU-only PyTorch.

```bash
docker build -t bassline-to-tab .
docker run --rm -p 7860:7860 bassline-to-tab
```

To publish it on a free [Hugging Face Space](https://huggingface.co/new-space)
(choose the **Docker** SDK and make it **private**, since you will upload
copyrighted songs), commit your changes and run:

```bash
deploy/huggingface/deploy.sh https://huggingface.co/spaces/<user>/<space>
```

The free CPU tier has 2 vCPU and 16 GB of RAM, so separating a song takes a few
minutes. Anyone who can open the Space can use it and consume its CPU.

## Limitations

- **Rhythm** is quantized to sixteenths in 4/4, with a single constant tempo.
  Triplets, swing, tempo changes and odd meters will come out wrong, and the
  first bar is aligned to the first strong note, not the real downbeat.
- **Notes, not technique**: slides, hammer-ons, ghost notes, slap and harmonics
  are not detected.
- **Fingering** is greedy. It looks one note back, not at the whole phrase.
- **Recordings far from A440** (around ±30 cents or more) can put some notes on
  the neighbouring semitone; the tool warns when it sees this.
- **Full mixes without Demucs** pick up kick drum and low guitar/keys notes.
- **No live microphone input** yet.

## Roadmap

1. Viterbi / dynamic-programming fingering over whole phrases.
2. Export to MusicXML / Guitar Pro (with durations, not just onsets).
3. Downbeat detection and smarter quantization (triplets, swing).
4. Note durations and rests in the tab.
5. Live input from the microphone (record → transcribe).

## Development

```bash
cargo test --all-features   # unit tests + end-to-end test on a synthetic riff
cargo clippy --all-targets --all-features
cargo fmt
```

## License

MIT for the code in this repository (see `LICENSE`).

The embedded model `models/basic_pitch_nmp.onnx` is part of
[Basic Pitch](https://github.com/spotify/basic-pitch) by Spotify AB, licensed
under the Apache License 2.0; see `models/LICENSE-basic-pitch` and
`models/NOTICE-basic-pitch`. The note-decoding algorithm in `src/notes.rs` is a
port of Basic Pitch's `note_creation.py`.
