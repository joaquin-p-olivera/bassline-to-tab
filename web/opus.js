// Opus compression of the bass stem for the song history. WebCodecs encodes
// the packets and this file wraps them in an Ogg container (RFC 7845), which
// both <audio> and decodeAudioData can read back.

/// Opus always runs at 48 kHz; the caller resamples to it.
export const OPUS_SAMPLE_RATE = 48000;
/// Mono at 128 kbps is transparent for a bass line: about 1 MB per minute,
/// against 5 MB for the 16-bit WAV.
const BITRATE = 128000;
/// libopus look-ahead at 48 kHz, used if the encoder does not report its own.
const DEFAULT_PRE_SKIP = 312;
/// Frames per AudioData handed to the encoder (one second).
const BLOCK_FRAMES = OPUS_SAMPLE_RATE;
const MAX_PAGE_SEGMENTS = 255;

const ENCODER_CONFIG = { codec: "opus", sampleRate: OPUS_SAMPLE_RATE, numberOfChannels: 1, bitrate: BITRATE };

export async function opusSupported() {
  try {
    return typeof AudioEncoder !== "undefined" && (await AudioEncoder.isConfigSupported(ENCODER_CONFIG)).supported === true;
  } catch {
    return false;
  }
}

export function isOpusBlob(blob) {
  return /ogg|opus|webm/.test(blob?.type ?? "");
}

/// Encodes mono samples at OPUS_SAMPLE_RATE into an Ogg Opus Blob.
/// `originalSampleRate` is only recorded in the header, as RFC 7845 asks.
export async function encodeOpus(samples, originalSampleRate = OPUS_SAMPLE_RATE) {
  const { packets, preSkip } = await encodePackets(samples);
  return new Blob(oggPages(packets, preSkip, samples.length, originalSampleRate), { type: "audio/ogg" });
}

async function encodePackets(samples) {
  const packets = [];
  let preSkip = DEFAULT_PRE_SKIP;
  let failure = null;
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const frames = Math.round(((chunk.duration ?? 20000) * OPUS_SAMPLE_RATE) / 1e6);
      packets.push({ data, frames });
      const description = metadata?.decoderConfig?.description;
      if (description) preSkip = opusHeadPreSkip(description) ?? preSkip;
    },
    error: (error) => (failure = error),
  });
  encoder.configure(ENCODER_CONFIG);
  for (let start = 0; start < samples.length && !failure; start += BLOCK_FRAMES) {
    const block = samples.subarray(start, start + BLOCK_FRAMES);
    const audio = new AudioData({
      format: "f32-planar",
      sampleRate: OPUS_SAMPLE_RATE,
      numberOfChannels: 1,
      numberOfFrames: block.length,
      timestamp: Math.round((start * 1e6) / OPUS_SAMPLE_RATE),
      data: block,
    });
    encoder.encode(audio);
    audio.close();
    // Keep the queue short so a long song is not copied into memory twice.
    while (encoder.encodeQueueSize > 4 && !failure) {
      await new Promise((resolve) => {
        encoder.addEventListener("dequeue", resolve, { once: true });
        setTimeout(resolve, 50);
      });
    }
  }
  if (!failure) await encoder.flush();
  if (encoder.state !== "closed") encoder.close();
  if (failure) throw failure;
  if (!packets.length) throw new Error("The Opus encoder produced no audio");
  return { packets, preSkip };
}

/// Pre-skip from an OpusHead header, if the description is one.
function opusHeadPreSkip(description) {
  const bytes = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description);
  if (bytes.length < 19 || new TextDecoder().decode(bytes.subarray(0, 8)) !== "OpusHead") return null;
  return bytes[10] | (bytes[11] << 8);
}

// ─── Ogg container ──────────────────────────────────────────────────────────

function opusHead(preSkip, originalSampleRate) {
  const bytes = new Uint8Array(19);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("OpusHead"));
  bytes[8] = 1; // version
  bytes[9] = 1; // channels
  view.setUint16(10, preSkip, true);
  view.setUint32(12, originalSampleRate, true);
  // Output gain 0 and channel mapping family 0 (mono/stereo) stay zero.
  return bytes;
}

function opusTags() {
  const vendor = new TextEncoder().encode("bassline-to-tab");
  const bytes = new Uint8Array(8 + 4 + vendor.length + 4);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("OpusTags"));
  view.setUint32(8, vendor.length, true);
  bytes.set(vendor, 12);
  // No user comments: the count stays zero.
  return bytes;
}

/// Packs the packets into Ogg pages. The last page's granule position trims
/// the encoder's padding, so the decoded length matches `totalFrames`.
function oggPages(packets, preSkip, totalFrames, originalSampleRate) {
  const serial = crypto.getRandomValues(new Uint32Array(1))[0];
  const pages = [];
  const addPage = (contents, granule, flags) => pages.push(oggPage(contents, granule, flags, serial, pages.length));

  addPage([opusHead(preSkip, originalSampleRate)], 0, 0x02);
  addPage([opusTags()], 0, 0);

  const endGranule = preSkip + totalFrames;
  let granule = 0;
  let contents = [];
  let segments = 0;
  packets.forEach((packet, index) => {
    const needed = Math.floor(packet.data.length / 255) + 1;
    if (segments + needed > MAX_PAGE_SEGMENTS) {
      addPage(contents, granule, 0);
      contents = [];
      segments = 0;
    }
    contents.push(packet.data);
    segments += needed;
    granule += packet.frames;
    if (index === packets.length - 1) addPage(contents, Math.min(granule, endGranule), 0x04);
  });
  return pages;
}

function oggPage(contents, granule, flags, serial, sequence) {
  const lacing = [];
  for (const data of contents) {
    for (let left = data.length; ; left -= 255) {
      lacing.push(Math.min(left, 255));
      if (left < 255) break;
    }
  }
  const bodySize = contents.reduce((sum, data) => sum + data.length, 0);
  const page = new Uint8Array(27 + lacing.length + bodySize);
  const view = new DataView(page.buffer);
  page.set(new TextEncoder().encode("OggS"));
  page[5] = flags;
  view.setBigUint64(6, BigInt(granule), true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let offset = 27 + lacing.length;
  for (const data of contents) {
    page.set(data, offset);
    offset += data.length;
  }
  view.setUint32(22, crc32(page), true);
  return page;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 24;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    table[i] = crc >>> 0;
  }
  return table;
})();

/// Ogg's CRC-32: polynomial 0x04c11db7, not reflected, initial value 0.
function crc32(bytes) {
  let crc = 0;
  for (const byte of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  return crc;
}
