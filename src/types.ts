export const AUDIO_SAMPLE_RATE = 24000;

export interface SpeakResult {
  transcript?: string;
}

/**
 * Interface that any TTS provider must implement.
 * All providers must output 24kHz 16-bit mono PCM audio.
 */
export interface TtsProvider {
  /**
   * Convert text to speech, streaming PCM audio chunks via the onAudio callback.
   * Resolves when the full utterance is done.
   *
   * @param text - The text to synthesize
   * @param onAudio - Callback that receives 24kHz 16-bit mono PCM chunks
   * @returns Optional SpeakResult with transcript (e.g. from agent mode)
   */
  speak(text: string, onAudio: (pcm: Buffer) => void): Promise<void | SpeakResult>;

  /** Optional cleanup — close persistent connections, free resources, etc. */
  destroy?(): void;
}

/**
 * Factory that creates a TtsProvider instance. Called once when joining a room.
 * Can be async to allow providers that need setup (e.g. opening a WebSocket session).
 */
export type TtsProviderFactory = () => TtsProvider | Promise<TtsProvider>;
