const TTS_CHUNK_LIMIT = 5000;

/** Split long text into chunks suitable for batch TTS APIs. */
export function splitTextForTTS(text: string): string[] {
  if (text.length <= TTS_CHUNK_LIMIT) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TTS_CHUNK_LIMIT) {
    let splitIdx = remaining.lastIndexOf(" ", TTS_CHUNK_LIMIT);
    if (splitIdx <= 0) splitIdx = TTS_CHUNK_LIMIT;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
