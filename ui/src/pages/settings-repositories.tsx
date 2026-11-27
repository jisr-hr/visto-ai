// The Repositories section of Settings (UI design 4.1; the mockup Settings.dc.html; calls 10, 26 and 28): the defaults and each
// repository's overrides, as a list and the pane of the one chosen, with its boxes Review, Score, Merge gate and Automatic approval.
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { SettingIssue } from '../api-types.ts';
import { Chips } from '../components/chips.tsx';
import { Segmented } from '../components/segmented.tsx';
import { Badge } from '../components/ui/badge.tsx';
import type { BadgeTone } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Switch } from '../components/ui/switch.tsx';
import { plural } from '../format.ts';
import { cn } from '../lib/utils.ts';
import { DEFAULTS, overridesOf, REPOSITORY_NAME, repositoryNames } from '../settings-draft.ts';
import { fieldValue, H2, LABELS, MONO, NumberField, OverrideLine, Row, SECTION, SourceLine, TextField, WORD } from './settings-parts.tsx';
import type { Form } from './settings-parts.tsx';

const BOX = 'rounded-[10px] border border-border px-[18px] py-1';
const H3 = 'mt-3.5 mb-0 text-sm font-semibold';
const HEAD = 'mt-3.5 flex items-center justify-between gap-2.5';
const HOW = 'mt-2.5 mb-1.5 flex flex-col gap-1.5 rounded-lg bg-subtle px-3.5 py-3 text-[13px] leading-[1.55]';
const REPO = 'flex min-h-11 w-full cursor-pointer items-center justify-between gap-2 rounded-lg border-0 bg-transparent px-3 py-2.5 text-left text-sm font-medium text-text hover:bg-subtle';

const MODE_HELP: Readonly<Record<string, string>> = {
  shadow:
    'Shadow: the check is written, but pushes are still reviewed as usual and nothing waits for /done, so you can watch what the gate would do before relying on it.',
  bypass: 'Bypass: the check always passes, and pull requests are reviewed only when someone asks. Use it to switch the gate off for a while without removing it.',
  enforce: 'Enforce: the check works as described above. Start in Shadow to see what it would block.',
};
const RULE_HELP: Readonly<Record<string, string>> = {
  gate: 'Gate rule: closed when the merge gate would let it pass: a later review found it fixed or answered, or a person replied and resolved the thread (when A reply clears a blocking finding is on).',
  strict:
    'Strict (recommended): closed when a later review checked the code and found it fixed, or when the thread is resolved and someone other than the author, a member or collaborator of the repository, replied in it after the last review. The author cannot close a finding alone.',
};

const Mono = ({ children }: { children: ReactNode }) => <span className={MONO}>{children}</span>;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** A list of names, written whole. */
function List({ form, scope, path, label, add, empty }: { form: Form; scope: string; path: string; label: string; add?: string; empty?: string }) {
  return <Chips label={label} addLabel={add} empty={empty} values={strings(form.shown(scope, path).value)} onChange={(next) => form.set(scope, path, next)} />;
}

/** A switch named by its row's label. */
function Toggle({ form, scope, path, labelId }: { form: Form; scope: string; path: string; labelId: string }) {
  return <Switch checked={form.shown(scope, path).value === true} labelledBy={labelId} onChange={(next) => form.set(scope, path, next)} />;
}

/** What a heading's switch came from: the override line in a repository, the source in the defaults. */
function HeadLine({ form, scope, path }: { form: Form; scope: string; path: string }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2.5">
      {scope === DEFAULTS ? <SourceLine form={form} scope={scope} path={path} /> : <OverrideLine form={form} scope={scope} path={path} />}
    </div>
  );
}

function Pane({ form, scope }: { form: Form; scope: string }) {
  const row = { form, scope } as const;
  const text = (path: string): string => {
    const value = form.shown(scope, path).value;
    return typeof value === 'string' ? value : '';
  };
  const gateOn = form.shown(scope, 'gate.enabled').value === true;
  const approveOn = form.shown(scope, 'score.autoApprove').value === true;
  const headValue = form.shown(scope, 'newHead').value;
  const threshold = form.shown(scope, 'score.threshold');
  const thresholdValue = typeof threshold.value === 'number' ? threshold.value : 0;
  const under = form.shown(DEFAULTS, 'score.threshold').value;
  const mode = text('gate.mode');
  const thread = text('score.approvalThreads');
  // The key the file writes; with none, the service generates one at its first start and keeps it in its database.
  const keyInFile = form.view.secrets.some((secret) => secret.kind === 'audit_key' && secret.variable !== null);
  const inRepository = scope !== DEFAULTS;
  return (
    <div className="flex min-w-0 shrink grow-[999] basis-[480px] flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <strong className="text-base">{scope === DEFAULTS ? 'Defaults for all' : scope}</strong>
        <Badge tone="muted">{inRepository ? 'Settings not overridden come from the defaults' : 'Every repository starts from these'}</Badge>
      </div>
      {inRepository && overridesOf(form.view, form.draft, scope) === 0 ? <p className={`m-0 ${WORD}`}>It is kept once it overrides a setting.</p> : null}

      <div className={BOX}>
        <h3 className={H3}>Review</h3>
        <Row {...row} path="primaryBranches" id="r-primary" label={LABELS.primaryBranches!} help="A pull request into one of these gets the elevated effort.">
          <List form={form} scope={scope} path="primaryBranches" label="Primary branches" />
        </Row>
        <Row {...row} path="ignoredAuthors" id="r-ignored" label={LABELS.ignoredAuthors!} help="Pull requests they open are not reviewed.">
          <List form={form} scope={scope} path="ignoredAuthors" label="Ignored authors" />
        </Row>
        <Row
          {...row}
          path="baseBranches"
          id="r-base"
          label={LABELS.baseBranches!}
          help={
            <>
              Pull requests into these branches are reviewed automatically after each push. Pull requests into any other branch are reviewed only when someone
              comments <Mono>/review</Mono> or <Mono>/done</Mono>, so a draft that keeps changing spends nothing. <Mono>*</Mono> means every branch. On a branch
              where the merge gate is on, pushes wait for <Mono>/done</Mono> instead, unless the gate is in Shadow mode.
            </>
          }
        >
          <List form={form} scope={scope} path="baseBranches" label="Reviewed on every push" empty="*" />
        </Row>
        <Row
          {...row}
          path="newHead"
          id="r-head"
          label={LABELS.newHead!}
          help="Incremental reads the files that changed; full reads every file again and costs about a first review."
        >
          <Segmented
            label="A new commit is reviewed"
            options={[{ value: 'incremental', label: 'Incremental' }, { value: 'full', label: 'Full' }]}
            value={headValue === 'incremental' || headValue === 'full' ? headValue : null}
            onChange={(next) => form.set(scope, 'newHead', next)}
          />
        </Row>
      </div>

      <div className={BOX}>
        <h3 className={H3}>Score</h3>
        <Row
          {...row}
          path="score.threshold"
          id="r-threshold"
          labelFor="r-th"
          label={LABELS['score.threshold']!}
          help="A file or block at or above it needs a person. See how it does on the Repositories page."
        >
          <div className="flex w-full flex-col gap-1.5">
            <div className="flex items-center gap-3">
              <input
                id="r-th"
                type="range"
                min="1"
                max="100"
                className="w-full accent-accent"
                value={thresholdValue}
                onChange={(event) => form.set(scope, 'score.threshold', Number(event.target.value))}
              />
              <span className="min-w-12 text-right font-semibold">{thresholdValue}%</span>
            </div>
            <div className="flex justify-between text-xs text-muted">
              <span>1</span>
              <span>{inRepository ? (threshold.written ? `Overrides the default of ${String(under)}%` : `From the defaults: ${String(under)}%`) : null}</span>
              <span>100</span>
            </div>
          </div>
        </Row>
        <Row {...row} path="score.inlineNotes" id="r-notes" label={LABELS['score.inlineNotes']!} help="A short note on each block listed for a person, on the diff itself.">
          <Toggle form={form} scope={scope} path="score.inlineNotes" labelId="r-notes" />
        </Row>
      </div>

      <div className={BOX}>
        <div className={HEAD}>
          <h3 id="r-gate" className="m-0 text-sm font-semibold">
            {LABELS['gate.enabled']}
          </h3>
          <Switch checked={gateOn} labelledBy="r-gate" onChange={(next) => form.set(scope, 'gate.enabled', next)} />
        </div>
        <HeadLine form={form} scope={scope} path="gate.enabled" />
        <div className={HOW}>
          <strong className="text-[13px] font-semibold">How it works</strong>
          <ol className="m-0 flex flex-col gap-1 pl-[18px]">
            <li>On a pull request into a gated branch, Visto AI adds a check to the latest commit. A push does not start a review: the check says it is waiting.</li>
            <li>
              When the pull request is ready, someone comments <Mono>/done</Mono> (or re-runs the check). Visto AI reviews it then.
            </li>
            <li>The check fails while a major or blocker finding is still open, and passes once none is. A new commit sets it back to waiting.</li>
            <li>For the check to stop merges, make it a required check in the branch&apos;s rules on GitHub. Visto AI cannot do that part.</li>
          </ol>
        </div>
        {gateOn ? (
          <>
            <Row
              {...row}
              path="gate.branches"
              id="r-gbranches"
              label={LABELS['gate.branches']!}
              help={
                <>
                  Pull requests whose base branch is one of these get the check, for example <Mono>main</Mono>. Names must match exactly. Pushes to these pull
                  requests are not reviewed automatically, even when the branch is in Reviewed on every push: they wait for <Mono>/done</Mono>. Shadow mode keeps
                  the push reviews. A * here is not every branch: it is read as a branch of that name.
                </>
              }
            >
              <List form={form} scope={scope} path="gate.branches" label="Gated branches" />
            </Row>
            <Row
              {...row}
              path="gate.checkName"
              id="r-check"
              labelFor="r-check-in"
              label={LABELS['gate.checkName']!}
              help="The name GitHub shows on the pull request. Use the same name when you make the check required on GitHub."
            >
              <TextField form={form} scope={scope} path="gate.checkName" id="r-check-in" className="max-w-[240px]" />
            </Row>
            <Row {...row} path="gate.mode" id="r-mode" label="Mode" help={MODE_HELP[mode] ?? MODE_HELP.enforce}>
              <Segmented
                label="Gate mode"
                options={[{ value: 'enforce', label: 'Enforce' }, { value: 'shadow', label: 'Shadow' }, { value: 'bypass', label: 'Bypass' }]}
                value={mode === 'enforce' || mode === 'shadow' || mode === 'bypass' ? mode : null}
                onChange={(next) => form.set(scope, 'gate.mode', next)}
              />
            </Row>
            <Row
              {...row}
              path="gate.clearByReply"
              id="r-reply"
              label={LABELS['gate.clearByReply']!}
              help="On: a person can clear a blocking finding by replying in its thread and resolving it, for example when the author explains why the code is right. Off: only a later review that finds it fixed, or a skip, clears it."
            >
              <Toggle form={form} scope={scope} path="gate.clearByReply" labelId="r-reply" />
            </Row>
            <Row
              {...row}
              path="gate.skipTeam"
              id="r-team"
              labelFor="r-team-in"
              label={LABELS['gate.skipTeam']!}
              help={
                <>
                  Members of this GitHub team can comment <Mono>/ai-review-skip</Mono> with a reason to let one commit pass without a review, for an urgent fix.
                  Empty: nobody can skip.
                </>
              }
            >
              <Input
                id="r-team-in"
                className={cn(MONO, 'max-w-[320px]')}
                value={fieldValue(form.shown(scope, 'gate.skipTeam').value)}
                onChange={(event) => form.set(scope, 'gate.skipTeam', event.target.value === '' ? null : event.target.value)}
              />
            </Row>
            <Row
              {...row}
              path="gate.requiredChecks"
              id="r-required"
              label={LABELS['gate.requiredChecks']!}
              help={
                <>
                  Your other checks, such as the build. When someone comments <Mono>/done</Mono> on a commit the gate already passed, the reply also says whether
                  these are green on it.
                </>
              }
            >
              <List form={form} scope={scope} path="gate.requiredChecks" label="Required checks" />
            </Row>
          </>
        ) : null}
      </div>

      <div className={cn(BOX, 'pb-2')}>
        <div className={HEAD}>
          <h3 id="r-approve" className="m-0 text-sm font-semibold">
            {LABELS['score.autoApprove']}
          </h3>
          <Switch checked={approveOn} labelledBy="r-approve" onChange={(next) => form.set(scope, 'score.autoApprove', next)} />
        </div>
        <HeadLine form={form} scope={scope} path="score.autoApprove" />
        {approveOn ? (
          <>
            <div className={HOW}>
              <strong className="text-[13px] font-semibold">How it works</strong>
              <span>
                Visto AI posts the review as an approval only when every file is reviewed, nothing is at or above the threshold, no major or blocker finding it
                raised is still open, the pull request is not a draft or from a fork, and the base branch&apos;s rules on GitHub dismiss old approvals when new
                commits are pushed. Any new commit takes the approval back.
              </span>
            </div>
            <Row
              {...row}
              path="score.approvalThreads"
              id="r-thread"
              label={LABELS['score.approvalThreads']!}
              help="When does a finding count as closed, so that it no longer holds the approval back?"
            >
              <div className="flex w-full flex-col items-stretch gap-2.5">
                <Segmented
                  label="Thread rule"
                  className="self-start"
                  options={[{ value: 'strict', label: 'Strict' }, { value: 'gate', label: 'Gate rule' }]}
                  value={thread === 'strict' || thread === 'gate' ? thread : null}
                  onChange={(next) => form.set(scope, 'score.approvalThreads', next)}
                />
                <span className="text-[13px] leading-[1.5]">{RULE_HELP[thread] ?? RULE_HELP.strict}</span>
              </div>
            </Row>
            <Row
              {...row}
              path="score.auditShare"
              id="r-audit"
              labelFor="r-audit-in"
              label={LABELS['score.auditShare']!}
              help="Of the pull requests that would be approved, the share sent to a person anyway. 0 turns the audit off."
            >
              <NumberField form={form} scope={scope} path="score.auditShare" id="r-audit-in" className="max-w-[120px]" />
              <span className="text-muted">%</span>
              <Badge tone="ok" dot>
                {keyInFile ? 'Audit key from config.yml' : 'Audit key generated'}
              </Badge>
            </Row>
            <p className="mt-1 mb-2 text-[13px] text-muted">
              It approves only where the base branch&apos;s rules dismiss stale approvals, and never a draft or a pull request from a fork.
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** A repository's note in the list: its issues if a refused save named it, else its overrides, else the defaults. */
function Note({ form, issues, name }: { form: Form; issues: readonly SettingIssue[]; name: string }) {
  const refused = issues.filter((issue) => issue.scope === name).length;
  const overrides = overridesOf(form.view, form.draft, name);
  let tone: BadgeTone = 'muted';
  let text = 'Defaults';
  if (refused > 0) {
    tone = 'bad';
    text = plural(refused, 'issue', 'issues');
  } else if (overrides > 0) {
    tone = 'accent';
    text = plural(overrides, 'override', 'overrides');
  }
  return <Badge tone={tone}>{text}</Badge>;
}

export function RepositoriesSection({ form, issues }: { form: Form; issues: readonly SettingIssue[] }) {
  const [chosen, setChosen] = useState<string>(DEFAULTS);
  const [added, setAdded] = useState<readonly string[]>([]);
  const [adding, setAdding] = useState(false);
  const [typed, setTyped] = useState('');
  const [refused, setRefused] = useState(false);
  const names = repositoryNames(form.view, form.draft, added);

  const option = (id: string, name: string, note: ReactNode) => (
    <button
      key={id}
      type="button"
      role="option"
      aria-selected={chosen === id}
      className={cn(REPO, chosen === id && 'bg-accent-soft text-accent-text hover:bg-accent-soft')}
      onClick={() => setChosen(id)}
    >
      <span>{name}</span>
      {note}
    </button>
  );

  const close = (): void => {
    setAdding(false);
    setTyped('');
    setRefused(false);
  };
  const submit = (): void => {
    const name = typed.trim().toLowerCase();
    if (!REPOSITORY_NAME.test(name)) {
      setRefused(true);
      return;
    }
    if (!names.includes(name)) setAdded((last) => [...last, name]);
    setChosen(name);
    close();
  };

  return (
    <section id="repos" aria-labelledby="repos-title" className={cn(SECTION, 'gap-4')}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="repos-title" className={H2}>
          Repositories
        </h2>
        <span className={WORD}>A repository uses the defaults unless it overrides a setting</span>
      </div>
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex max-w-[260px] shrink grow basis-[200px] flex-col gap-0.5">
          <div role="listbox" aria-label="Repository" className="flex flex-col gap-0.5">
            {option(DEFAULTS, 'Defaults for all', <Badge tone="muted">Defaults</Badge>)}
            {names.map((name) => option(name, name, <Note form={form} issues={issues} name={name} />))}
          </div>
          {adding ? (
            <div className="mt-2 flex flex-col gap-2">
              <Input
                aria-label="Repository to add"
                placeholder="owner/name"
                autoFocus
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    submit();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    close();
                  }
                }}
              />
              {refused ? <span className="text-[13px] text-bad">Write it as owner/name.</span> : null}
              <div className="flex gap-2">
                <Button type="button" variant="primary" onClick={submit}>
                  Add
                </Button>
                <Button type="button" onClick={close}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button type="button" className="mt-2 justify-center" onClick={() => setAdding(true)}>
              Add a repository
            </Button>
          )}
        </div>
        <Pane key={chosen} form={form} scope={chosen} />
      </div>
    </section>
  );
}
