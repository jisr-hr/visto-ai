const LF = 10;
const CR = 13;

/**
 * Reads an event stream and yields the data of each event that has any, in order. Lines that begin with a colon, and the fields
 * event, id and retry, are passed over. Ends when the stream ends. Throws Error('answer_too_large') once more than maxBytes were read.
 * When its consumer stops early, or it throws, the stream is cancelled.
 */
export async function* eventData(body: ReadableStream<Uint8Array>, maxBytes: number): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let finished = false;
  let read = 0;
  let line = '';
  let skipLF = false;
  let data: string[] = [];
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) {
        finished = true;
        return;
      }
      read += step.value.byteLength;
      if (read > maxBytes) throw new Error('answer_too_large');
      const text = decoder.decode(step.value, { stream: true });
      let start = 0;
      for (let i = 0; i < text.length; i += 1) {
        const c = text.charCodeAt(i);
        if (skipLF) {
          skipLF = false;
          if (c === LF) {
            start = i + 1;
            continue;
          }
        }
        if (c !== LF && c !== CR) continue;
        const whole = line + text.slice(start, i);
        line = '';
        start = i + 1;
        if (c === CR) skipLF = true;
        if (whole === '') {
          const joined = data.join('\n');
          const had = data.length > 0;
          data = [];
          if (had && joined !== '') yield joined;
          continue;
        }
        if (whole.charCodeAt(0) === 58) continue;
        const colon = whole.indexOf(':');
        const field = colon === -1 ? whole : whole.slice(0, colon);
        if (field !== 'data') continue;
        let value = colon === -1 ? '' : whole.slice(colon + 1);
        if (value.charCodeAt(0) === 32) value = value.slice(1);
        data.push(value);
      }
      line += text.slice(start);
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
