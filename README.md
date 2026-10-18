# bassline-to-tab

Choose a song, get its bass line as tablature. It runs entirely in the
browser, on your own device: no server, no uploads, no install.

**App:** https://joaquin-p-olivera.github.io/bassline-to-tab/

```
  1                                2
G|--------------------------------|--------------------------------|
D|--------------------------------|0-------------------------------|
A|----------------0-------2---3---|--------3---2---0---------------|
E|0-------0---3-------------------|------------------------3---2---|
```

## How it works

```
song file ─► decode (Web Audio API)
          ─► Demucs HTDemucs: separate the bass stem ........ WebGPU (device GPU)
          ─► Basic Pitch: note/onset activations ............ WebAssembly (CPU)
          ─► notes ─► tuning + tempo ─► fret positions ─► tab + MIDI
```

Everything heavy runs in a Web Worker so the page stays responsive.
Two pre-trained neural networks do the listening (HTDemucs separates the
bass, Basic Pitch detects pitches); the music logic that turns their output
into a playable tab is this project's own: octave correction, onset
refinement, tempo and tuning estimation, and Viterbi fingering.

**→ [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** explains every stage, the
files and functions that implement it, and what is third-party versus own.

Features:
- **Play along**: the tab follows the audio (bass only or full mix) with a
  cursor on the current sixteenth; tap a bar to jump there.
- **Your songs**: each song, its separated bass and its last tab are saved in
  the browser (IndexedDB). Reopening a song or changing the settings reuses
  the separated bass, so transcribing again takes seconds instead of minutes.
- The tab wraps to the screen width (no horizontal scrolling).

| Part | Where | What |
| --- | --- | --- |
| `crates/core` | Rust | Platform-agnostic transcription: Basic Pitch inference (ONNX via [tract](https://github.com/sonos/tract), model embedded), note decoding, onset refinement, tuning and tempo estimation, fret assignment, ASCII tab, MIDI. |
| `crates/web` | Rust → wasm | `wasm-bindgen` bindings: `separate_bass` (HTDemucs via [demucs-rs](https://github.com/nikhilunni/demucs-rs) on WebGPU) and `transcribe`. |
| `web/` | HTML/JS | The page (`index.html`, `app.js`), the worker (`worker.js`), the interactive tab (`tab-view.js`) and the song history (`storage.js`). |
| `scripts/build-web.sh` | Bash | Builds the wasm module and assembles the site. |
| `.github/workflows/web.yml` | CI | On every push: builds the wasm (with clippy) and runs the end-to-end tests in headless Chromium. |
| `.github/workflows/deploy.yml` | CI | Manual only (Actions → Deploy to GitHub Pages → Run workflow): builds and tests a branch, then deploys it to GitHub Pages. Branches other than `main` need `confirm_non_main: yes`. |

The first separation downloads the HTDemucs weights (~84 MB) from Hugging
Face; the browser caches them for next time.

## Browser support

Separation needs **WebGPU**. Check your device at https://webgpureport.org.

- **iPhone / iPad**: iOS 26+ (Safari, and Chrome, which uses the same engine).
- **Mac / Windows / ChromeOS**: recent Chrome or Edge.
- **Android**: recent Chrome on most devices, depending on the GPU.

Without WebGPU the app still transcribes an **isolated** bass recording
(turn off "Separate the bass").

## Limitations

- **Separation is slow.** On a Mac in Chrome it takes ~35–45 s per ~8 s
  chunk, so a 4-minute song needs ~30 minutes (transcription afterwards takes
  seconds). Phones are untested. See [#2](https://github.com/joaquin-p-olivera/bassline-to-tab/issues/2).
  Keep the computer awake while it runs; sleep can interrupt the GPU work.
- **Rhythm** is quantized to sixteenths in 4/4 with one constant tempo.
  Triplets, swing, tempo changes and odd meters come out wrong, and bar 1 is
  aligned to the first strong note rather than the real downbeat.
- **Notes, not technique**: slides, hammer-ons, ghost notes and slap are not
  detected.
- **Fingering** is a guess: the string is not detected from the sound. Every
  transcription comes in two fingerings, open position (low frets, open
  strings) and lower strings (E/A higher up the neck), and a toggle above the
  tab switches between them. A line that mixes both may still land on the
  wrong string.
- **Note detection** was tuned on a single real recording (about 82% of notes
  at the exact pitch); other songs and mixes may need retuning. Some notes
  still come out an octave too high.
- **Recordings far from A440** (±30 cents or more) can put notes on the
  neighbouring semitone; the app warns when it sees this.

## Roadmap

1. Faster separation ([#2](https://github.com/joaquin-p-olivera/bassline-to-tab/issues/2)).
2. Manual tab editing ([#4](https://github.com/joaquin-p-olivera/bassline-to-tab/issues/4)).
3. Validate and retune note detection on more recordings.
4. Note durations and rests in the tab; MusicXML / Guitar Pro export.
5. Downbeat detection and smarter quantization (triplets, swing).

## Development

Native tests (the transcription core, including an end-to-end test of the
real model on a synthetic riff):

```bash
cargo test -p bassline-core
cargo clippy -p bassline-core --all-targets
cargo fmt --all
```

Build and serve the web app locally (Rust 1.91+):

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129   # must match Cargo.lock
scripts/build-web.sh                               # builds into _site/
python3 -m http.server 8000 --directory _site      # open http://localhost:8000
```

The module is built without GPU kernel autotuning: while benchmarking kernel
variants for HTDemucs, some run past the GPU watchdog (Apple mobile GPUs hang,
and macOS kills the command buffer with a GPU timeout).

End-to-end test (after assembling `_site`):

```bash
cd web/e2e && npm install && npx playwright install chromium && npx playwright test
```

## License

MIT for the code in this repository (see `LICENSE`).

Third-party components (see `NOTICE`):
- [Basic Pitch](https://github.com/spotify/basic-pitch) model by Spotify AB,
  Apache-2.0, embedded in the build; `crates/core/src/notes.rs` ports its
  note-creation algorithm.
- [demucs-rs](https://github.com/nikhilunni/demucs-rs), Apache-2.0, compiled
  into the WebAssembly module.
- HTDemucs weights from [Demucs](https://github.com/facebookresearch/demucs)
  by Meta, MIT, downloaded by the browser at runtime (not redistributed here).
