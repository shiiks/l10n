/**
 * AudioWorklet: mixes incoming audio to mono, downsamples to 16 kHz (what
 * speech models expect), and posts Float32 batches to the main thread.
 */
const TARGET_RATE = 16000;
const BATCH = 1600; // 100 ms at 16 kHz

class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.acc = 0;
    this.sum = 0;
    this.count = 0;
    this.out = new Float32Array(BATCH);
    this.outLen = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const n = channels[0].length;

    for (let i = 0; i < n; i++) {
      let mono = 0;
      for (let c = 0; c < channels.length; c++) mono += channels[c][i];
      mono /= channels.length;

      // Box-filter decimation: average `ratio` input samples per output sample.
      this.sum += mono;
      this.count++;
      this.acc += 1;
      if (this.acc >= this.ratio) {
        this.out[this.outLen++] = this.sum / this.count;
        this.sum = 0;
        this.count = 0;
        this.acc -= this.ratio;
        if (this.outLen === BATCH) {
          this.port.postMessage(this.out.slice(0));
          this.outLen = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PCMCapture);
