import OpusScript from "opusscript";

const OPUS_SAMPLE_RATE = 48000;
const OPUS_FRAME_DURATION_MS = 20;
const OPUS_FRAME_SIZE = (OPUS_SAMPLE_RATE * OPUS_FRAME_DURATION_MS) / 1000; // 960 samples
const OPUS_CHANNELS = 1;
const OPUS_BITRATE = 32000;

const INPUT_SAMPLE_RATE = 24000;
const INPUT_FRAME_SIZE = (INPUT_SAMPLE_RATE * OPUS_FRAME_DURATION_MS) / 1000; // 480 samples

function upsample24to48(input: Buffer): Buffer {
  const samples = input.length / 2;
  const output = Buffer.alloc(samples * 2 * 2); // 2x samples, 2 bytes each

  for (let i = 0; i < samples - 1; i++) {
    const s0 = input.readInt16LE(i * 2);
    const s1 = input.readInt16LE((i + 1) * 2);
    const mid = Math.round((s0 + s1) / 2);

    output.writeInt16LE(s0, i * 4);
    output.writeInt16LE(mid, i * 4 + 2);
  }

  const last = input.readInt16LE((samples - 1) * 2);
  output.writeInt16LE(last, (samples - 1) * 4);
  output.writeInt16LE(last, (samples - 1) * 4 + 2);

  return output;
}

function downsample48to24(input: Buffer): Buffer {
  const samples = input.length / 2;
  const output = Buffer.alloc(Math.floor(samples / 2) * 2);

  for (let i = 0; i < Math.floor(samples / 2); i++) {
    const val = input.readInt16LE(i * 4);
    output.writeInt16LE(val, i * 2);
  }

  return output;
}

export class OpusEncoder {
  private encoder: OpusScript;
  private buffer: Buffer;

  constructor() {
    this.encoder = new OpusScript(OPUS_SAMPLE_RATE, OPUS_CHANNELS, OpusScript.Application.VOIP);
    this.encoder.setBitrate(OPUS_BITRATE);
    this.buffer = Buffer.alloc(0);
  }

  encode(pcm24kHz: Buffer): Buffer[] {
    this.buffer = Buffer.concat([this.buffer, pcm24kHz]);

    const frames: Buffer[] = [];
    const bytesPerInputFrame = INPUT_FRAME_SIZE * 2;

    while (this.buffer.length >= bytesPerInputFrame) {
      const chunk = this.buffer.subarray(0, bytesPerInputFrame);
      this.buffer = this.buffer.subarray(bytesPerInputFrame);

      const upsampled = upsample24to48(chunk);
      const encoded = this.encoder.encode(upsampled, OPUS_FRAME_SIZE);
      frames.push(Buffer.from(encoded));
    }

    return frames;
  }

  flush(): Buffer[] {
    if (this.buffer.length === 0) return [];

    const bytesPerInputFrame = INPUT_FRAME_SIZE * 2;
    const padded = Buffer.alloc(bytesPerInputFrame);
    this.buffer.copy(padded);
    this.buffer = Buffer.alloc(0);

    const upsampled = upsample24to48(padded);
    const encoded = this.encoder.encode(upsampled, OPUS_FRAME_SIZE);
    return [Buffer.from(encoded)];
  }

  destroy(): void {
    this.encoder.delete();
  }
}

export class OpusDecoder {
  private decoder: OpusScript;

  constructor() {
    this.decoder = new OpusScript(OPUS_SAMPLE_RATE, OPUS_CHANNELS, OpusScript.Application.VOIP);
  }

  decode(opusFrame: Buffer): Buffer {
    const pcm48 = this.decoder.decode(opusFrame);
    return downsample48to24(Buffer.from(pcm48));
  }

  destroy(): void {
    this.decoder.delete();
  }
}
