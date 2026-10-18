// AudioWorklet for the microphone recorder (see app.js): collects the samples
// of the first input channel and hands them to the main thread in blocks, so
// the recording is kept as raw PCM (no lossy encoding before transcription).

/// Samples per message: about 85 ms at 48 kHz, often enough for the level meter.
const BLOCK = 4096;

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(BLOCK);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const count = Math.min(channel.length - offset, BLOCK - this.filled);
      this.block.set(channel.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === BLOCK) {
        this.port.postMessage(this.block, [this.block.buffer]);
        this.block = new Float32Array(BLOCK);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("recorder", RecorderProcessor);
