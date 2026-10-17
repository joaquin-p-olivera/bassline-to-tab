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
| `scripts/build-web.sh` | Bash | Builds both wasm variants and assembles the site. |
| `.github/workflows/pages.yml` | CI | Builds the wasm, runs an end-to-end test in headless Chromium, deploys to GitHub Pages. |

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

- **Speed on phones is untested.** Separation runs a large model over
  ~8-second chunks; expect anything from seconds to a few minutes per song
  depending on the GPU. The app shows how long each stage took.
- **Rhythm** is quantized to sixteenths in 4/4 with one constant tempo.
  Triplets, swing, tempo changes and odd meters come out wrong, and bar 1 is
  aligned to the first strong note rather than the real downbeat.
- **Notes, not technique**: slides, hammer-ons, ghost notes and slap are not
  detected.
- **Fingering** is greedy (looks one note back, not at the whole phrase).
- **Recordings far from A440** (±30 cents or more) can put notes on the
  neighbouring semitone; the app warns when it sees this.

## Roadmap

1. Measure and tune separation speed on phones.
2. Viterbi / dynamic-programming fingering over whole phrases.
3. Note durations and rests in the tab; MusicXML / Guitar Pro export.
4. Downbeat detection and smarter quantization (triplets, swing).
5. Playback that highlights the current tab position.

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

Two builds of the module are produced: `pkg/` with GPU kernel autotuning
(desktop; much faster separation) and `pkg-mobile/` without it (autotuning
hangs Apple mobile GPUs). The page picks one based on the device.

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
