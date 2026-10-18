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
| `web/` | HTML/JS | The page (`index.html`, `app.js`), the worker (`worker.js`), the interactive tab (`tab-view.js`), the song history (`storage.js`) and its export/import file (`archive.js`), the fretboard page with every fret's note (`fretboard.html`, `fretboard.js`), and the light/dark toggle every page shares (`theme.js`, saved in `localStorage`, defaulting to the system setting). |
| `scripts/build-web.sh` | Bash | Builds the wasm module and assembles the site. |
| `.github/workflows/web.yml` | CI | On every push: builds the wasm (with clippy) and runs the end-to-end tests in headless Chromium. |
| `.github/workflows/deploy.yml` | CI | Manual only (Actions → Deploy to GitHub Pages → Run workflow): builds and tests a branch, then deploys it to GitHub Pages. Branches other than `main` need `confirm_non_main: yes`. |

The first separation downloads the HTDemucs weights (~84 MB) from Hugging
Face; the browser caches them for next time.

## Song history file (`.bltab`)

"Your songs" lives in the browser's IndexedDB. **Export songs** saves every
song to one `.bltab` file and **Import songs** loads it back, in the same or
another browser. It is a format of our own (written and read by
[`web/archive.js`](web/archive.js)), not a zip: no extra library is needed,
and the browser reads each audio file straight from the archive instead of
loading the whole thing into memory.

### Layout

All integers are little endian. Offsets in the manifest are relative to the
start of the data section, not to the start of the file.

| Bytes | Content |
| --- | --- |
| 0–7 | Magic: the ASCII text `BLTABHX1` (identifies the file; `1` is the layout version). |
| 8–11 | `N`: length of the manifest in bytes (unsigned 32-bit). |
| 12 … 12+N−1 | Manifest: UTF-8 JSON (below). |
| 12+N … end | Data section: every binary value of every song, back to back, with no padding or separators. |

### Manifest

```json
{
  "format": "bassline-to-tab-history",
  "version": 1,
  "exportedAt": 1792364400000,
  "songs": [
    {
      "id": "song.mp3|5000000|1760000000000",
      "name": "song.mp3",
      "createdAt": 1792360000000,
      "duration": 214.5,
      "separated": true,
      "file": { "$blob": { "offset": 0, "size": 5000000, "type": "audio/mpeg",
                           "name": "song.mp3", "lastModified": 1760000000000 } },
      "bassWav": { "$blob": { "offset": 5000000, "size": 18900000, "type": "audio/wav" } },
      "lastOptions": { "tuning": "standard", "frets": 24, "bpm": null },
      "lastResult": { "bpm": 100.2, "notes": [], "events": [], "tab": "…",
                      "midi": { "$bytes": { "offset": 23900000, "size": 412, "kind": "Uint8Array" } } }
    }
  ]
}
```

Each song is the IndexedDB record (see [`web/storage.js`](web/storage.js))
with its binary values replaced by references into the data section:

- `{"$blob": {offset, size, type, name?, lastModified?}}`: a Blob (the bass
  stem, a 16-bit mono WAV). With `name` and `lastModified` it is a File (the
  original audio), which keeps the song's `id` stable.
- `{"$bytes": {offset, size, kind}}`: a typed array (the MIDI), where `kind`
  is its type (`Uint8Array`, `Float32Array`, …) or `ArrayBuffer`.

Everything else is plain JSON. A song without a separated bass has
`"bassWav": null`; one never transcribed has no `lastResult`.

### Reading and writing

- **Export** walks each record, appends every binary value to the data
  section and writes its offset and size in the manifest. The file is
  assembled as a `Blob` of the parts, so nothing is copied in memory.
- **Import** reads the 12-byte header and checks the magic, reads and parses
  the manifest, checks `format` and `version`, and turns each reference
  back into a slice of the chosen file (`file.slice(start, start + size)`).
  References that point outside the file are rejected as a damaged file.
- Songs are matched by `id`. If some already exist, the app asks whether to
  replace them or keep yours and import only the new ones.
- A file with a newer `version` than the app knows is rejected, so a future
  layout change bumps `version` (and the magic's last digit if the header
  itself changes).

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
