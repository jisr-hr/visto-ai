// Lessons: sentences a model wrote from people's replies to the reviewer's findings (7.2 to 7.4). Their fixed sizes,
// and the one rule for a lesson's text, which runs where a lesson is made and again where it is shown.
import { cleanLine } from './extensions.ts';

export const LESSONS_SHOWN = 8;            // lessons in one review
export const LESSON_MIN_CHARS = 30;
export const LESSON_CHARS = 300;

export type LessonRefusal = 'not_a_rule' | 'names_the_score';

// A pull request number, or a link: a lesson is a rule for other pull requests (7.3, call 3).
const NOT_GENERAL = [/#\d/, /:\/\//];
// The score, a person's review, or an approval (call 4): a filter on words, which catches a judge that strays into scoring.
const NAMES_THE_SCORE = /\bscor(e|es|ed|ing)\b|\bhuman review\b|\bneeds? a (human|person)\b|\bauto-?approv|\bautomatic(ally)? approv|\bapprovable\b/i;

/** The one cleaner and checker of a lesson's text, where a lesson is made and where it is shown. A text is never cut to fit. */
export function lessonText(raw: unknown): { ok: true; text: string } | { ok: false; code: LessonRefusal } {
  if (typeof raw !== 'string' || raw.length > 4 * LESSON_CHARS) return { ok: false, code: 'not_a_rule' };
  const text = cleanLine(raw, 4 * LESSON_CHARS).text;
  if (text.length < LESSON_MIN_CHARS || text.length > LESSON_CHARS) return { ok: false, code: 'not_a_rule' };
  if (NOT_GENERAL.some((pattern) => pattern.test(text))) return { ok: false, code: 'not_a_rule' };
  if (NAMES_THE_SCORE.test(text)) return { ok: false, code: 'names_the_score' };
  return { ok: true, text };
}
