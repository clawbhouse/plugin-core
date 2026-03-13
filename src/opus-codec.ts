import OpusScript from "opusscript";

const SAMPLE_RATE = 24000;
const FRAME_DURATION_MS = 20;
const FRAME_SIZE = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 480 samples
const CHANNELS = 1;
const BITRATE = 32000;

export class OpusEncoder {
  private encoder: OpusScript;
  private buffer: Buffer;

  constructor() {
    this.encoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.VOIP);
    this.encoder.setBitrate(BITRATE);
    this.buffer = Buffer.alloc(0);
  }

  encode(pcm24kHz: Buffer): Buffer[] {
    this.buffer = Buffer.concat([this.buffer, pcm24kHz]);

    const frames: Buffer[] = [];
    const bytesPerFrame = FRAME_SIZE * 2;

    while (this.buffer.length >= bytesPerFrame) {
      const chunk = this.buffer.subarray(0, bytesPerFrame);
      this.buffer = this.buffer.subarray(bytesPerFrame);

      const encoded = this.encoder.encode(chunk, FRAME_SIZE);
      frames.push(Buffer.from(encoded));
    }

    return frames;
  }

  flush(): Buffer[] {
    if (this.buffer.length === 0) return [];

    const bytesPerFrame = FRAME_SIZE * 2;
    const padded = Buffer.alloc(bytesPerFrame);
    this.buffer.copy(padded);
    this.buffer = Buffer.alloc(0);

    const encoded = this.encoder.encode(padded, FRAME_SIZE);
    return [Buffer.from(encoded)];
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }

  destroy(): void {
    this.encoder.delete();
  }
}

export class OpusDecoder {
  private decoder: OpusScript;

  constructor() {
    this.decoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.VOIP);
  }

  decode(opusFrame: Buffer): Buffer {
    return Buffer.from(this.decoder.decode(opusFrame));
  }

  destroy(): void {
    this.decoder.delete();
  }
}
