const LF = 10;
const CR = 13;
const COLON = 58;
const SPACE = 32;
const BOM = 0xfeff;
const DECODER = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * Bytes kept in one buffer that doubles as it fills, so that many small pieces cost their bytes and nothing for each piece.
 */
export class ByteBuffer {
  #bytes = new Uint8Array(256);
  #length = 0;

  get length(): number {
    return this.#length;
  }

  append(piece: Uint8Array): void {
    if (piece.byteLength === 0) return;
    const needed = this.#length + piece.byteLength;
    if (needed > this.#bytes.byteLength) {
      let size = this.#bytes.byteLength;
      while (size < needed) size *= 2;
      const grown = new Uint8Array(size);
      grown.set(this.#bytes.subarray(0, this.#length));
      this.#bytes = grown;
    }
    this.#bytes.set(piece, this.#length);
    this.#length = needed;
  }

  /** The bytes as UTF-8 text, a byte order mark kept; a character cut between two pieces is whole again. */
  text(): string {
    return DECODER.decode(this.#bytes.subarray(0, this.#length));
  }

  clear(): void {
    this.#length = 0;
  }
}

/**
 * Reads an event stream and yields the data of each event that has any, in order. Lines that begin with a colon, and the fields
 * event, id and retry, are passed over. Ends when the stream ends. Throws Error('answer_too_large') once more than maxBytes were read.
 * When its consumer stops early, or it throws, the stream is cancelled.
 */
export async function* eventData(body: ReadableStream<Uint8Array>, maxBytes: number): AsyncGenerator<string> {
  const reader = body.getReader();
  let finished = false;
  let read = 0;
  let first = true;
  const line = new ByteBuffer();
  let skipLF = false;
  let data: string[] = [];
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) {
        finished = true;
        return;
      }
      const chunk = step.value;
      read += chunk.byteLength;
      if (read > maxBytes) throw new Error('answer_too_large');
      // CR and LF are single bytes that never occur inside a UTF-8 character, so lines are cut on bytes and decoded whole
      let start = 0;
      for (let i = 0; i < chunk.byteLength; i += 1) {
        const c = chunk[i]!;
        if (skipLF) {
          skipLF = false;
          if (c === LF) {
            start = i + 1;
            continue;
          }
        }
        if (c !== LF && c !== CR) continue;
        line.append(chunk.subarray(start, i));
        start = i + 1;
        if (c === CR) skipLF = true;
        let whole = line.text();
        line.clear();
        if (first) {
          first = false;
          if (whole.charCodeAt(0) === BOM) whole = whole.slice(1);
        }
        if (whole === '') {
          const joined = data.join('\n');
          const had = data.length > 0;
          data = [];
          if (had && joined !== '') yield joined;
          continue;
        }
        if (whole.charCodeAt(0) === COLON) continue;
        const colon = whole.indexOf(':');
        const field = colon === -1 ? whole : whole.slice(0, colon);
        if (field !== 'data') continue;
        let value = colon === -1 ? '' : whole.slice(colon + 1);
        if (value.charCodeAt(0) === SPACE) value = value.slice(1);
        data.push(value);
      }
      line.append(chunk.subarray(start));
    }
  } finally {
    if (!finished) {
      try {
        reader.cancel().catch(() => {});
      } catch {
        // the stream is already gone
      }
    }
  }
}
