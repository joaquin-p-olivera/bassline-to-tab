// Web Worker: runs the WebAssembly pipeline off the main thread.
//
// Messages in:  { id, type: "info" | "separate" | "transcribe", ... }
// Messages out: { id, type: "progress", stage, done, total }
//               { id, type: "done", ... } | { id, type: "error", message }

const wasm = await import("./pkg/bassline_web.js");
const { separate, separation_weights_size_mb, separation_weights_url, transcribe, transcription_sample_rate } = wasm;

const WEIGHTS_CACHE = "bassline-to-tab-weights-v1";
const ready = wasm.default();

async function openCache() {
  try {
    return await caches.open(WEIGHTS_CACHE);
  } catch (error) {
    console.warn("Cache Storage unavailable, weights will not be cached", error);
    return null;
  }
}

async function readWithProgress(response, expectedBytes, onProgress) {
  const total = Number(response.headers.get("content-length")) || expectedBytes;
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, Math.max(total, loaded));
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function loadWeights(model, onProgress) {
  const url = separation_weights_url(model);
  const cache = await openCache();
  const cached = cache && (await cache.match(url));
  if (cached) {
    console.info("Demucs weights loaded from cache");
    return new Uint8Array(await cached.arrayBuffer());
  }
  console.info("Downloading Demucs weights from", url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download the Demucs model (HTTP ${response.status})`);
  }
  const bytes = await readWithProgress(response, separation_weights_size_mb(model) * 1e6, onProgress);
  if (cache) {
    try {
      await cache.put(url, new Response(bytes, { headers: { "content-type": "application/octet-stream" } }));
    } catch (error) {
      console.warn("Could not cache the Demucs weights", error);
    }
  }
  return bytes;
}

/// data: { model: "htdemucs" | "htdemucs_6s", stems: ["bass", "guitar"], left, right, sampleRate }.
/// Replies with stems: { bass: { left, right }, ... }.
async function handleSeparate(data, post) {
  const weights = await loadWeights(data.model, (done, total) =>
    post({ type: "progress", stage: "download", done, total }),
  );
  const started = performance.now();
  const separated = await separate(weights, data.model, data.stems, data.left, data.right, data.sampleRate, (done, total) =>
    post({ type: "progress", stage: "separate", done, total }),
  );
  const stems = {};
  const transfer = [];
  data.stems.forEach((name, i) => {
    const half = separated[i].length / 2;
    const left = separated[i].slice(0, half);
    const right = separated[i].slice(half);
    stems[name] = { left, right };
    transfer.push(left.buffer, right.buffer);
  });
  const seconds = (performance.now() - started) / 1000;
  post({ type: "done", stems, sampleRate: data.sampleRate, seconds }, transfer);
}

function handleTranscribe(data, post) {
  const started = performance.now();
  const result = transcribe(data.samples, data.options, (done, total) =>
    post({ type: "progress", stage: "transcribe", done, total }),
  );
  post({ type: "done", result, seconds: (performance.now() - started) / 1000 });
}

self.onmessage = async ({ data }) => {
  const post = (message, transfer = []) => self.postMessage({ id: data.id, ...message }, transfer);
  try {
    await ready;
    switch (data.type) {
      case "info":
        post({
          type: "done",
          transcriptionSampleRate: transcription_sample_rate(),
          weightsSizeMb: separation_weights_size_mb("htdemucs"),
          guitarWeightsSizeMb: separation_weights_size_mb("htdemucs_6s"),
        });
        break;
      case "separate":
        await handleSeparate(data, post);
        break;
      case "transcribe":
        handleTranscribe(data, post);
        break;
      default:
        throw new Error(`Unknown request type: ${data.type}`);
    }
  } catch (error) {
    console.error(error);
    post({ type: "error", message: String(error?.message ?? error) });
  }
};
