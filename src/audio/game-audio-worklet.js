const CHANNELS = 2;
const START_BUFFER_FRAMES = 2_400;
const MAX_BUFFER_FRAMES = 7_200;
const RECOVERY_BUFFER_FRAMES = 2_400;

class GameAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.chunkOffset = 0;
    this.queuedFrames = 0;
    this.playing = false;
    this.reportedState = "buffering";
    this.port.onmessage = (event) => {
      if (event.data?.type !== "audio" || !(event.data.pcm instanceof ArrayBuffer)) return;
      const samples = new Int8Array(event.data.pcm);
      if (samples.length === 0 || samples.length % CHANNELS !== 0) return;
      this.chunks.push(samples);
      this.queuedFrames += samples.length / CHANNELS;
      if (this.queuedFrames > MAX_BUFFER_FRAMES) {
        this.dropOldestFrames(RECOVERY_BUFFER_FRAMES);
      }
    };
  }

  process(_inputs, outputs) {
    const left = outputs[0]?.[0];
    const right = outputs[0]?.[1];
    if (!left || !right) return true;

    if (!this.playing && this.queuedFrames >= START_BUFFER_FRAMES) {
      this.playing = true;
      this.reportState("playing");
    }

    if (!this.playing) return true;
    for (let index = 0; index < left.length; index += 1) {
      const frame = this.readFrame();
      if (frame === null) {
        this.playing = false;
        this.reportState("buffering");
        break;
      }
      left[index] = frame[1] / 128;
      right[index] = frame[0] / 128;
    }
    return true;
  }

  readFrame() {
    while (this.chunks.length > 0) {
      const chunk = this.chunks[0];
      if (this.chunkOffset + 1 < chunk.length) {
        const frame = [chunk[this.chunkOffset], chunk[this.chunkOffset + 1]];
        this.chunkOffset += CHANNELS;
        this.queuedFrames -= 1;
        return frame;
      }
      this.chunks.shift();
      this.chunkOffset = 0;
    }
    this.queuedFrames = 0;
    return null;
  }

  dropOldestFrames(targetFrames) {
    while (this.queuedFrames > targetFrames && this.chunks.length > 0) {
      const chunk = this.chunks[0];
      const availableFrames = (chunk.length - this.chunkOffset) / CHANNELS;
      const framesToDrop = Math.min(availableFrames, this.queuedFrames - targetFrames);
      this.chunkOffset += framesToDrop * CHANNELS;
      this.queuedFrames -= framesToDrop;
      if (this.chunkOffset >= chunk.length) {
        this.chunks.shift();
        this.chunkOffset = 0;
      }
    }
  }

  reportState(state) {
    if (state === this.reportedState) return;
    this.reportedState = state;
    this.port.postMessage({ type: "state", state });
  }
}

registerProcessor("game-audio", GameAudioProcessor);
