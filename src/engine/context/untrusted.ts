// Handling of text written by the pull request author. It is data, never instructions.

// C0 controls except tab (\u0009) and newline (\u000a), DEL, C1 controls,
// zero-width and direction marks, embeddings and overrides, invisible operators,
// isolates, and the byte order mark.
const INVISIBLE =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

const INLINE_LIMIT = 300;

export function stripControl(text: string): { text: string; removed: number } {
  const normalised = text.replaceAll('\r\n', '\n');
  let removed = 0;
  const cleaned = normalised.replace(INVISIBLE, () => {
    removed += 1;
    return '';
  });
  return { text: cleaned, removed };
}

// Single-line form of untrusted text: control characters stripped, each newline
// and tab turned into one space, cut to INLINE_LIMIT characters.
export function inlineText(text: string): string {
  const { text: stripped } = stripControl(text);
  return stripped.replace(/[\n\t]/g, ' ').slice(0, INLINE_LIMIT);
}

// Deletion can join the pieces around an occurrence into a new one, so repeat
// until none is left. Each pass shortens the text, so this terminates.
function deleteToken(text: string, token: string): string {
  let result = text;
  while (result.includes(token)) {
    result = result.replaceAll(token, '');
  }
  return result;
}

export function wrapData(label: string, text: string, token: string): string {
  if (token === '') {
    throw new Error('empty marker token');
  }
  const safeLabel = deleteToken(inlineText(label), token);
  const body = deleteToken(text, token);
  return `<<<data ${token} ${safeLabel}>>>\n${body}\n<<<end ${token}>>>`;
}
