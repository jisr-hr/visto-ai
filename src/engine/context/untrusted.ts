// Handling of text written by the pull request author. It is data, never instructions.

// C0 controls except tab (\u0009) and newline (\u000a), DEL, C1 controls,
// zero-width and direction marks, embeddings and overrides, invisible operators,
// isolates, and the byte order mark.
const INVISIBLE =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

export function stripControl(text: string): { text: string; removed: number } {
  const normalised = text.replaceAll('\r\n', '\n');
  let removed = 0;
  const cleaned = normalised.replace(INVISIBLE, () => {
    removed += 1;
    return '';
  });
  return { text: cleaned, removed };
}

export function wrapData(label: string, text: string, token: string): string {
  if (token === '') {
    throw new Error('empty marker token');
  }
  const body = text.replaceAll(token, '');
  return `<<<data ${token} ${label}>>>\n${body}\n<<<end ${token}>>>`;
}
