// The pieces of the Settings page that every section shares (UI design 4; the mockup Settings.dc.html): the form the sections
// read and write through, each setting's label, a row with its label, help, control, where its value came from, and the issues
// a refused save named at it, and the controls that need state of their own (a number, a JSON field).
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { SettingsView, SettingValue } from '../api-types.ts';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { fieldClasses, Input } from '../components/ui/input.tsx';
import { utc } from '../format.ts';
import { cn } from '../lib/utils.ts';
import { DEFAULTS, GLOBAL, keyOf, numberOrText, UNSET, valueText } from '../settings-draft.ts';
import type { Draft, Shown, Unset } from '../settings-draft.ts';

/** What every row and control reads and writes: the view, the draft over it, the issues of a refused save, the JSON fields not valid. */
export interface Form {
  view: SettingsView;
  draft: Draft;
  /** Counts up when the draft is discarded or saved, so a field holding text of its own starts again from the value. */
  epoch: number;
  shown(scope: string, path: string): Shown;
  set(scope: string, path: string, value: SettingValue | Unset): void;
  issuesAt(scope: string, path: string): string[];
  setBadJson(key: string, bad: boolean): void;
  /** The draft keys of JSON fields whose text is not valid JSON. */
  bad: ReadonlySet<string>;
  /** Takes the draft's entries for these paths of one scope away, so each reads as the view has it. */
  drop(scope: string, paths: readonly string[]): void;
}

/** Each path's row label (also how a refused save names it). */
export const LABELS: Readonly<Record<string, string>> = {
  dryRun: 'Dry run',
  learning: 'Learning',
  'limits.spendPerDay': 'Daily spend limit',
  'limits.queueConcurrency': 'Reviews at once',
  'limits.inputTokensPerCall': 'Input tokens per call',
  'limits.batchesPerReview': 'Batches per review',
  'model.baseUrl': 'Endpoint',
  'model.model': 'Model',
  'model.fallbacks': 'Fallbacks',
  'model.effort.default': 'Effort, default',
  'model.effort.elevated': 'Effort, elevated',
  'model.toolChoice': 'How the answer is asked for',
  'model.timeoutSeconds': 'Time limit per call',
  'model.prices': 'Prices per million tokens',
  'model.extraBody': 'Extra body',
  'model.extraHeaders': 'Extra headers',
  'scorer.model': 'Second scorer',
  'scorer.baseUrl': 'Second scorer endpoint',
  'scorer.timeoutSeconds': 'Second scorer time limit',
  primaryBranches: 'Primary branches',
  ignoredAuthors: 'Ignored authors',
  baseBranches: 'Reviewed on every push',
  newHead: 'A new commit is reviewed',
  'score.threshold': 'Threshold',
  'score.inlineNotes': 'Inline notes',
  'score.autoApprove': 'Automatic approval',
  'score.approvalThreads': 'Thread rule',
  'score.auditShare': 'Audit share',
  'gate.enabled': 'Merge gate',
  'gate.branches': 'Gated branches',
  'gate.checkName': 'Check name',
  'gate.mode': 'Gate mode',
  'gate.clearByReply': 'A reply clears a blocking finding',
  'gate.skipTeam': 'Team that may skip',
  'gate.requiredChecks': 'Required checks',
};

/** Where a setting is on the page: General, Model, the defaults, or its repository. */
export function whereOf(scope: string, path: string): string {
  if (scope === GLOBAL) return path.startsWith('model.') || path.startsWith('scorer.') ? 'Model' : 'General';
  return scope === DEFAULTS ? 'Defaults for all' : scope;
}

// The mockup's pieces, in the theme's tokens.
export const SECTION = 'flex flex-col rounded-[12px] border border-border bg-card px-6 py-5 shadow-card';
export const H2 = 'm-0 text-[17px] font-semibold';
export const MONO = 'font-mono text-[12.5px]';
export const WORD = 'text-[13px] text-muted';
const ROW = 'flex flex-wrap items-start gap-x-8 gap-y-3 border-t border-border py-4 first-of-type:border-t-0';
const LBL = 'flex min-w-0 shrink grow basis-[260px] flex-col gap-1';
const CTL = 'flex min-w-0 shrink grow basis-[300px] flex-wrap items-center gap-2.5';

/** A value as a field holds it: a number stays a number (so a number field keeps what was typed), text stays text, the rest is empty. */
export function fieldValue(value: SettingValue): string | number {
  return typeof value === 'number' || typeof value === 'string' ? value : '';
}

/** Where a setting's value came from (call 28); nothing for a value the draft sets, and "Not written" for one the draft takes back. */
export function SourceLine({ form, scope, path, prefix = '' }: { form: Form; scope: string; path: string; prefix?: string }) {
  const now = form.shown(scope, path);
  let text: string | null;
  if (now.edited) text = now.written ? null : 'Not written';
  else if (!now.written) text = scope === DEFAULTS && path === 'newHead' ? 'Not set: incremental, and full where the merge gate holds pushes' : 'The default';
  else if (now.source === null) text = null;
  else if (now.source.by === 'config.yml') text = `From config.yml at the start of ${utc(now.source.at)}`;
  else text = now.source.name === null ? `Changed in the UI, ${utc(now.source.at)}` : `Changed in the UI by ${now.source.name}, ${utc(now.source.at)}`;
  return text === null ? null : <span className="text-xs text-muted">{`${prefix}${text}`}</span>;
}

/** A repository's setting (call 28): not written, it comes from the defaults; written, it says what it overrides and can take the default back. */
function OverrideLine({ form, scope, path }: { form: Form; scope: string; path: string }) {
  if (!form.shown(scope, path).written) return <span className="text-xs text-muted">From the defaults</span>;
  return (
    <>
      <span className="text-xs font-medium text-accent-text">Overrides {valueText(path, form.shown(DEFAULTS, path).value)}</span>
      <SourceLine form={form} scope={scope} path={path} />
      <Button type="button" className="min-h-7 px-2 text-xs" onClick={() => form.set(scope, path, UNSET)}>
        Use the default
      </Button>
    </>
  );
}

/**
 * One setting: its label (a `label` for a field, else a name the control is labelled by), its help, its control, the badges of a
 * restart, where the value came from, and each issue a refused save named at it. `also` are the paths of other settings the
 * control writes; their sources and issues show here too.
 */
export function Row({
  id,
  label,
  help,
  labelFor,
  restart,
  waits = false,
  also = [],
  form,
  scope,
  path,
  children,
}: {
  id: string;
  label: string;
  help: ReactNode;
  labelFor?: string;
  /** The badge beside the label, over "Needs a restart", which a setting the service reads once at start gets of itself. */
  restart?: string;
  /** A save of this waits for the restart, over what the setting says of itself. */
  waits?: boolean;
  also?: readonly string[];
  form: Form;
  scope: string;
  path: string;
  children: ReactNode;
}) {
  const paths = [path, ...also];
  const issues = paths.flatMap((one) => form.issuesAt(scope, one));
  const bad = paths.some((one) => form.bad.has(keyOf(scope, one)));
  const badge = restart ?? (paths.some((one) => form.shown(scope, one).restart) ? 'Needs a restart' : undefined);
  const field = labelFor ?? id;
  return (
    <div data-slot="setting-row" className={ROW}>
      <div data-slot="setting-label" className={LBL}>
        <div className="flex flex-wrap items-center gap-2">
          {labelFor === undefined ? (
            <strong id={id} className="text-sm font-medium">
              {label}
            </strong>
          ) : (
            <label id={id} htmlFor={labelFor} className="text-sm font-medium">
              {label}
            </label>
          )}
          {badge === undefined ? null : <Badge tone="muted">{badge}</Badge>}
        </div>
        <span className="text-[13px] leading-[1.45] text-muted">{help}</span>
      </div>
      <div data-slot="setting-control" className={CTL}>
        {children}
        {waits || paths.some((one) => form.shown(scope, one).waits) ? <Badge tone="warn">Takes effect when the service restarts</Badge> : null}
        {scope !== GLOBAL && scope !== DEFAULTS ? (
          <OverrideLine form={form} scope={scope} path={path} />
        ) : (
          paths.map((one) => (
            <SourceLine key={one} form={form} scope={scope} path={one} prefix={paths.length > 1 ? `${one.slice(one.lastIndexOf('.') + 1).replace(/^./, (c) => c.toUpperCase())}: ` : ''} />
          ))
        )}
        {bad ? (
          <p id={`${field}-bad`} className="w-full text-[13px] text-bad">
            Not valid JSON.
          </p>
        ) : null}
        {issues.map((issue, index) => (
          <p key={`${index}-${issue}`} id={`${field}-issue-${index}`} className="w-full text-[13px] text-bad">
            {issue}
          </p>
        ))}
      </div>
    </div>
  );
}

/** A number field, written as a number while its text is one (the service refuses any other at the field). */
export function NumberField({ form, scope, path, id, className }: { form: Form; scope: string; path: string; id?: string; className?: string }) {
  return (
    <Input
      id={id}
      type="number"
      className={className}
      value={fieldValue(form.shown(scope, path).value)}
      onChange={(event) => form.set(scope, path, numberOrText(event.target.value))}
    />
  );
}

/** A row that only tells: a label, its help and what config.yml says (Access). */
export function PlainRow({ id, label, help, children }: { id: string; label: string; help: ReactNode; children: ReactNode }) {
  return (
    <div data-slot="setting-row" className={ROW}>
      <div data-slot="setting-label" className={LBL}>
        <strong id={id} className="text-sm font-medium">
          {label}
        </strong>
        <span className="text-[13px] leading-[1.45] text-muted">{help}</span>
      </div>
      <div data-slot="setting-control" className={CTL}>
        {children}
      </div>
    </div>
  );
}

/** A text field. */
export function TextField({ form, scope, path, id, className, label, disabled }: { form: Form; scope: string; path: string; id?: string; className?: string; label?: string; disabled?: boolean }) {
  return (
    <Input
      id={id}
      aria-label={label}
      className={className}
      disabled={disabled}
      value={fieldValue(form.shown(scope, path).value)}
      onChange={(event) => form.set(scope, path, event.target.value)}
    />
  );
}

/**
 * A JSON field: what is typed is kept as typed while it is valid, and written as the value it reads as; text that is not JSON writes
 * nothing, says so, and keeps the page from saving. It starts again from the value when the draft is discarded or saved.
 */
function JsonFieldOf({ form, scope, path, id }: { form: Form; scope: string; path: string; id: string }) {
  const [typed, setTyped] = useState<string | null>(null);
  const bad = form.bad.has(keyOf(scope, path));
  const issues = form.issuesAt(scope, path);
  const value = form.shown(scope, path).value;
  const text = typed ?? JSON.stringify(value, null, 2);
  const described = bad ? [`${id}-bad`] : issues.map((_, index) => `${id}-issue-${index}`);
  return (
    <textarea
      id={id}
      className={cn(fieldClasses, 'min-h-24 w-full py-2 font-mono text-[12.5px]')}
      spellCheck={false}
      aria-invalid={bad || issues.length > 0}
      aria-describedby={described.length === 0 ? undefined : described.join(' ')}
      value={text}
      onChange={(event) => {
        const next = event.target.value;
        setTyped(next);
        try {
          const parsed = JSON.parse(next.trim() === '' ? '{}' : next) as SettingValue;
          form.setBadJson(keyOf(scope, path), false);
          form.set(scope, path, parsed);
        } catch {
          form.setBadJson(keyOf(scope, path), true);
        }
      }}
    />
  );
}

export function JsonField(props: { form: Form; scope: string; path: string; id: string }) {
  return <JsonFieldOf key={props.form.epoch} {...props} />;
}
