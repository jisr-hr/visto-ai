// What the Overview says of an alert, a dependency and the automatic approval, in words (rules 5 to 7 of Task 10). Pure: a short
// code and a model's name are written between backticks, and the page draws the text through `codeSpans`.
import type { AlertShown, ApprovalShort, DependencyPart, DependencyShown } from './api-types.ts';
import { ago, dollars, sentence, utc } from './format.ts';

export type Tone = 'bad' | 'warn' | 'muted' | 'ok';

/** The alerts whose pair can end or whose state can clear, so that a recent one of them is resolved. */
const OPEN_ABLE: ReadonlySet<string> = new Set([
  'model_error', 'memory_error', 'dismissal_failed', 'spend_limit', 'spend_80', 'mcp_error', 'extension_error', 'feature_off',
]);
/** The open alerts that fail the service, rather than warn of it. */
const FAILING: ReadonlySet<string> = new Set(['model_error', 'memory_error', 'dismissal_failed', 'spend_limit']);

const text = (value: string | number | boolean | undefined): string => (value === undefined ? '' : String(value));
const code = (value: string | number | boolean | undefined): string => `\`${text(value)}\``;
const num = (value: string | number | boolean | undefined): number => (typeof value === 'number' ? value : Number(value) || 0);

function modelTitle(reason: string): string {
  if (reason === 'auth') return 'The review model refused the key';
  if (reason === 'no_credit') return 'The review model is out of credit';
  return 'The review model is failing';
}

/** The title and the detail of an alert, ages counted from `now`. */
function alertText(alert: AlertShown, now: string): { title: string; detail: string } {
  const d = alert.details;
  const when = ago(alert.raisedAt, now);
  switch (alert.code) {
    case 'model_error':
      return { title: modelTitle(text(d.reason)), detail: `Seen by ${d.seen_by === 'check' ? 'the key check' : 'a review'}, ${when}.` };
    case 'spend_limit':
      return { title: 'Spend reached the daily limit', detail: `${dollars(num(d.spent))} of ${dollars(num(d.limit))}. Reviews start again with the next UTC day.` };
    case 'spend_80':
      return { title: 'Spend reached 80% of the daily limit', detail: `${dollars(num(d.spent))} of ${dollars(num(d.limit))}, ${when}.` };
    case 'cost_unknown':
      return { title: 'A review used tokens but cost nothing', detail: `Without prices the daily limit sees no spend, ${when}.` };
    case 'mcp_error':
      return { title: `MCP server ${text(d.server)} is failing`, detail: `${code(d.reason)}, ${when}.` };
    case 'extension_error':
      return { title: `Extension ${text(d.extension)} is failing`, detail: `Its ${text(d.part)} part: ${code(d.reason)}, ${when}.` };
    case 'memory_error':
      return { title: 'Memory could not be read', detail: `${code(d.reason)}, ${when}. Reviews go on without it.` };
    case 'learning_stale':
      return { title: `Learning has not run for ${text(d.hours)} hours`, detail: `${when}.` };
    case 'lessons_stale':
      return { title: `Lessons have not been judged for ${text(d.hours)} hours`, detail: `${when}.` };
    case 'gate_check_failed':
      return { title: 'A merge gate check could not be set', detail: `${code(d.reason)}, ${when}.` };
    case 'gate_bypass':
      return { title: "A repository's merge gate is in bypass", detail: `Said at each start, ${when}.` };
    case 'feature_off':
      return { title: `The GitHub App lacks ${text(d.missing)}`, detail: `So ${code(d.feature)} is off. A start finds it once it is granted.` };
    case 'redelivery_failed':
      return { title: 'Missed deliveries could not all be asked for again', detail: `${code(d.reason)}, ${when}.` };
    case 'dismissal_failed':
      return { title: 'An approval could not be withdrawn', detail: `${text(d.repo)} #${text(d.number)}, ${code(d.reason)}.` };
    case 'stale_approval_merged':
      return { title: 'An approval stood when its pull request merged', detail: `${text(d.repo)} #${text(d.number)}, ${when}.` };
    default:
      return { title: alert.code, detail: `${when}.` };
  }
}

export function alertWords(alert: AlertShown, now: string): { tone: Tone; badge: string; title: string; detail: string } {
  const { title, detail } = alertText(alert, now);
  if (alert.open) {
    return FAILING.has(alert.code) ? { tone: 'bad', badge: 'Failing', title, detail } : { tone: 'warn', badge: 'Warning', title, detail };
  }
  return { tone: 'muted', badge: OPEN_ABLE.has(alert.code) ? 'Resolved' : 'Recent', title, detail };
}

const PART_WORDS: Readonly<Record<DependencyPart['part'], string>> = { context: 'context', notify: 'notices', alert: 'alerts', route: 'a route' };

/** `['context', 'notify']` as `Context and notices`. */
export function partsWords(parts: readonly DependencyPart['part'][]): string {
  const words = parts.map((part) => PART_WORDS[part]);
  const last = words.at(-1);
  if (last === undefined) return '';
  return sentence(words.length === 1 ? last : `${words.slice(0, -1).join(', ')} and ${last}`);
}

const BADGES: Readonly<Record<DependencyShown['status'], { tone: Tone; badge: string }>> = {
  working: { tone: 'ok', badge: 'Working' },
  failing: { tone: 'bad', badge: 'Failing' },
  unknown: { tone: 'muted', badge: 'Not checked yet' },
};

/** `<code> since <time>`, of what is known. */
function failing(failure: { code: string | null; since: string | null }): string {
  return `\`${failure.code ?? 'unknown'}\`${failure.since === null ? '' : ` since ${utc(failure.since)}`}`;
}

function titleOf(dependency: DependencyShown): string {
  const name = dependency.name === null ? '' : ` ${dependency.name}`;
  switch (dependency.kind) {
    case 'model':
      return 'Review model';
    case 'scorer':
      return 'Second scorer';
    case 'memory':
      return 'Memory';
    case 'mcp':
      return `MCP server${name}`;
    case 'extension':
      return `Extension${name}`;
    case 'app':
      return 'GitHub App';
  }
}

/** What the app lacks, its first item first. */
function missingLine(missing: DependencyShown['missing']): string {
  const first = missing[0]?.missing ?? '';
  const colon = first.indexOf(':');
  const name = colon < 0 ? first : first.slice(0, colon);
  const rest = colon < 0 ? '' : first.slice(colon + 1);
  const line = name === 'event' ? `Event \`${rest}\` not subscribed` : `Permission \`${name}\` (${rest}) not granted`;
  return missing.length > 1 ? `${line}, and ${missing.length - 1} more` : line;
}

/** The line of a dependency that is not failing. */
function stateLine(dependency: DependencyShown, now: string): string {
  const seen = dependency.seenAt === null ? null : ago(dependency.seenAt, now);
  const model = dependency.model === null ? null : `\`${dependency.model}\``;
  const unknown = dependency.status === 'unknown';
  switch (dependency.kind) {
    case 'model':
      if (model === null) return unknown ? 'Not checked yet' : `Checked ${seen ?? ''}`.trim();
      return unknown || seen === null ? `${model}, not checked yet` : `${model}, checked ${seen}`;
    case 'scorer':
      if (model === null) return unknown ? 'Not used yet' : '';
      return unknown ? `${model}, not used yet` : model;
    case 'memory':
      return unknown || seen === null ? 'No lookup yet' : `Last lookup ${seen}`;
    case 'mcp':
      return unknown || seen === null ? 'Not used yet' : `Last used ${seen}`;
    case 'extension': {
      const parts = partsWords(dependency.parts.map((part) => part.part));
      return unknown ? `${parts}, not used yet` : parts;
    }
    case 'app':
      return unknown ? 'Not checked yet' : 'Permissions and events as needed';
  }
}

export function dependencyWords(dependency: DependencyShown, now: string): { title: string; tone: Tone; badge: string; line: string } {
  const title = titleOf(dependency);
  if (dependency.kind === 'app' && dependency.missing.length > 0) {
    return { title, tone: 'warn', badge: `Missing ${dependency.missing.length}`, line: missingLine(dependency.missing) };
  }
  const { tone, badge } = BADGES[dependency.status];
  if (dependency.status === 'failing' && dependency.kind !== 'app') {
    if (dependency.kind === 'extension') {
      const part = dependency.parts.find((one) => one.status === 'failing');
      if (part !== undefined) return { title, tone, badge, line: `${sentence(PART_WORDS[part.part])} failing: ${failing(part)}` };
    }
    return { title, tone, badge, line: failing(dependency) };
  }
  return { title, tone, badge, line: stateLine(dependency, now) };
}

export function approvalWords(approval: ApprovalShort): { tone: Tone; text: string } {
  if (!approval.enabled) return { tone: 'muted', text: 'Off' };
  const audit = approval.auditShare > 0 ? `${approval.auditShare}% audit` : 'no audit';
  return { tone: 'ok', text: `On, ${approval.threads === 'strict' ? 'strict' : 'gate rule'}, ${audit}` };
}
