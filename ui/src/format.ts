// How the screens write logins, ages, durations, time left, times in UTC, money and counts (Task 10, rule 1; call 22: every age
// and time left is counted from the `now` an answer carries, never from the browser's clock).

/** Whole seconds from `from` to `to`; a time that cannot be read counts as none. */
function secondsBetween(from: string, to: string): number {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) ? ms / 1000 : 0;
}

/** The first characters of the first two parts of a login split on -, _ and ., or of its one part; `?` when it has none. */
export function initials(login: string): string {
  const parts = login.split(/[-_.]/).filter((part) => part !== '');
  const [first, second] = parts;
  if (first === undefined) return '?';
  if (second === undefined) return first.slice(0, 2).toUpperCase();
  return (first.charAt(0) + second.charAt(0)).toUpperCase();
}

/** How long ago `at` was at `now`; a time after `now` is 0 seconds ago. */
export function ago(at: string, now: string): string {
  const seconds = Math.max(0, Math.floor(secondsBetween(at, now)));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 172_800) return 'yesterday';
  return `${Math.floor(seconds / 86_400)} days ago`;
}

/** A duration in rounded seconds; one below 0 is 0. */
export function took(ms: number): string {
  const seconds = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/** The time from `now` to `runAt` in minutes and seconds, the seconds rounded up; a time already past is 0:00. */
export function left(runAt: string, now: string): string {
  const seconds = Math.max(0, Math.ceil(secondsBetween(now, runAt)));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** `YYYY-MM-DD HH:MM UTC`, the seconds dropped; a time that cannot be read is ''. */
export function utc(at: string): string {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return '';
  const time = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  const day = `${String(time.getUTCFullYear()).padStart(4, '0')}-${two(time.getUTCMonth() + 1)}-${two(time.getUTCDate())}`;
  return `${day} ${two(time.getUTCHours())}:${two(time.getUTCMinutes())} UTC`;
}

export function money(cost: number): string {
  return `$${cost.toFixed(3)}`;
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A whole number with a comma between each three digits; one below 0 or not finite is 0. */
export function count(n: number): string {
  const whole = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  return String(whole).replace(/\B(?=(\d{3})+$)/g, ',');
}

/** The parts of a text: a span between two backticks on one line is code (without them), the rest text; empty parts are dropped. */
export function codeSpans(text: string): Array<{ code: boolean; text: string }> {
  const parts: Array<{ code: boolean; text: string }> = [];
  let last = 0;
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    if (match.index > last) parts.push({ code: false, text: text.slice(last, match.index) });
    parts.push({ code: true, text: match[1]! });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last) });
  return parts;
}

/** The text with its first character upper-cased. */
export function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A share as a whole percent; none is `None`. */
export function percent(share: number | null): string {
  return share === null ? 'None' : `${Math.round(share * 100)}%`;
}

/** Money with cents. */
export function dollars(n: number): string {
  return `$${n.toFixed(2)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `YYYY-MM-DD` as the UTC month's three letters and the day without a leading zero; a day that cannot be read is ''. */
export function shortDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) return '';
  const month = MONTHS[Number(match[2]) - 1];
  return month === undefined ? '' : `${month} ${Number(match[3])}`;
}
