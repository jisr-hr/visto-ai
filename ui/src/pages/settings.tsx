// The Settings page, for a signed-in admin (UI design 4 and 5; calls 9 to 12, 22, 25 and 28): its header with the unsaved changes,
// Discard and Save; the sections of the form (General, Model, Secrets, Access); and the accounts. What the person changes is a
// draft over the view the service gave; Save sends only what differs from the view, with the view's version, and a refusal is
// shown at each setting it names and all together at the top. The accounts, and the page's heading, show whatever the read does.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { RequestFailed } from '../api.ts';
import type { SecretKind, SecretState, SettingIssue, SettingsView, SettingValue } from '../api-types.ts';
import { CHIP, Chips } from '../components/chips.tsx';
import { PageHeader } from '../components/layout.tsx';
import { Segmented } from '../components/segmented.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Select } from '../components/ui/select.tsx';
import { Switch } from '../components/ui/switch.tsx';
import { useApp } from '../context.tsx';
import { plural } from '../format.ts';
import { changesOf, DEFAULTS, effortChoice, effortValue, GLOBAL, isUnset, keyOf, numberOrText, shown, UNSET, withChange } from '../settings-draft.ts';
import type { Draft, EffortChoice } from '../settings-draft.ts';
import { AccountsSection } from './accounts.tsx';
import { ChangesSection, ExportSection } from './settings-record.tsx';
import { RepositoriesSection } from './settings-repositories.tsx';
import { fieldValue, H2, JsonField, LABELS, MONO, NumberField, PlainRow, Row, SECTION, TextField, whereOf, WORD } from './settings-parts.tsx';
import type { Form } from './settings-parts.tsx';

const SUB = 'Saved settings apply from the next review. A review already running keeps the settings it started with.';
const CHANGED = 'Settings were saved meanwhile, here or in config.yml at a start. They were read again, and your changes are kept: save again.';
const FAILED = 'The settings could not be saved.';
const BUSY = 'The service is busy. Try again in a moment.';
const UNREACHABLE = 'The service could not be reached. Try again in a moment.';
const NAV: ReadonlyArray<readonly [string, string]> = [['general', 'General'], ['model', 'Model'], ['repos', 'Repositories'], ['secrets', 'Secrets'], ['access', 'Access'], ['accounts', 'Accounts'], ['changes', 'Changes'], ['export', 'In config.yml']];
const SCORER_PATHS = ['scorer.baseUrl', 'scorer.model', 'scorer.timeoutSeconds'] as const;

/** What the top of the page says of a save that did not go through: the issues, or a sentence. */
type Notice = { kind: 'issues'; issues: SettingIssue[] } | { kind: 'text'; text: string };


function failureOf(error: unknown): string {
  if (error instanceof RequestFailed && error.status === 503) return BUSY;
  if (error instanceof RequestFailed && error.status === 0) return UNREACHABLE;
  return FAILED;
}

// -- the sections ---------------------------------------------------------------------------------------------------------------

/** A switch named by its row's label, and the word for its state. */
function Toggle({ form, path, labelId }: { form: Form; path: string; labelId: string }) {
  const on = form.shown(GLOBAL, path).value === true;
  return (
    <>
      <Switch checked={on} labelledBy={labelId} onChange={(next) => form.set(GLOBAL, path, next)} />
      <span className={WORD}>{on ? 'On' : 'Off'}</span>
    </>
  );
}

function General({ form }: { form: Form }) {
  const row = { form, scope: GLOBAL } as const;
  return (
    <section id="general" aria-labelledby="general-title" className={SECTION}>
      <h2 id="general-title" className={`${H2} mb-1`}>
        General
      </h2>
      <Row {...row} path="dryRun" id="l-dry" label={LABELS.dryRun!} help="Reviews are run and recorded, and nothing is posted to GitHub.">
        <Toggle form={form} path="dryRun" labelId="l-dry" />
      </Row>
      <Row
        {...row}
        path="learning"
        id="l-learn"
        label={LABELS.learning!}
       
        help="Learn from what people do on pull requests: where they stepped in, reverts, and replies to findings."
      >
        <Toggle form={form} path="learning" labelId="l-learn" />
      </Row>
      <Row
        {...row}
        path="limits.spendPerDay"
        id="l-spend"
        labelFor="g-spend"
        label={LABELS['limits.spendPerDay']!}
        help="Reviews wait once the day's model spend reaches it. An alert is raised at 80%."
      >
        <span className="text-muted">$</span>
        <NumberField form={form} scope={GLOBAL} path="limits.spendPerDay" id="g-spend" className="max-w-[140px]" />
      </Row>
      <Row {...row} path="limits.queueConcurrency" id="l-conc" labelFor="g-conc" label={LABELS['limits.queueConcurrency']!} help="How many reviews run side by side.">
        <NumberField form={form} scope={GLOBAL} path="limits.queueConcurrency" id="g-conc" className="max-w-[140px]" />
      </Row>
      <Row
        {...row}
        path="limits.inputTokensPerCall"
        id="l-tok"
        labelFor="g-tok"
        label={LABELS['limits.inputTokensPerCall']!}
        help="The most one model call is sent. A larger pull request is split into batches."
      >
        <NumberField form={form} scope={GLOBAL} path="limits.inputTokensPerCall" id="g-tok" className="max-w-[180px]" />
      </Row>
      <Row {...row} path="limits.batchesPerReview" id="l-bat" labelFor="g-bat" label={LABELS['limits.batchesPerReview']!} help="Files past the last batch are listed as not reviewed.">
        <NumberField form={form} scope={GLOBAL} path="limits.batchesPerReview" id="g-bat" className="max-w-[140px]" />
      </Row>
    </section>
  );
}

const EFFORT_OPTIONS: ReadonlyArray<readonly [Exclude<EffortChoice, 'custom'>, string]> = [['none', 'Provider default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];

/** One of the two efforts: its choices, and the written-in-config.yml one only while the value is not one of them. */
function Effort({ form, path, label }: { form: Form; path: string; label: string }) {
  const choice = effortChoice(form.shown(GLOBAL, path).value);
  return (
    <label className="flex items-center gap-2 text-[13px] text-muted">
      {label}
      <Select
        className="w-auto"
        value={choice}
        onChange={(event) => {
          const next = event.target.value;
          if (next === 'none' || next === 'low' || next === 'medium' || next === 'high') form.set(GLOBAL, path, effortValue(next));
        }}
      >
        {EFFORT_OPTIONS.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
        {choice === 'custom' ? <option value="custom">As written in config.yml</option> : null}
      </Select>
    </label>
  );
}

const PRICE_KEYS = [['inputPerMillion', 'Input'], ['cachedInputPerMillion', 'Cached'], ['outputPerMillion', 'Output']] as const;

/** The three prices; all three empty writes none. */
function Prices({ form }: { form: Form }) {
  const value = form.shown(GLOBAL, 'model.prices').value;
  const prices: { [key: string]: SettingValue } = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
  const texts = (): Record<string, string | number> => Object.fromEntries(PRICE_KEYS.map(([key]) => [key, fieldValue(prices[key] ?? null)]));
  const change = (key: string, text: string): void => {
    const next = { ...texts(), [key]: text };
    if (PRICE_KEYS.every(([each]) => String(next[each]) === '')) form.set(GLOBAL, 'model.prices', null);
    else form.set(GLOBAL, 'model.prices', Object.fromEntries(PRICE_KEYS.map(([each]) => [each, numberOrText(String(next[each]))])));
  };
  return (
    <>
      {PRICE_KEYS.map(([key, label]) => (
        <label key={key} className="flex flex-col gap-1 text-[13px] text-muted">
          {label}
          <Input type="number" className="w-[100px]" value={fieldValue(prices[key] ?? null)} onChange={(event) => change(key, event.target.value)} />
        </label>
      ))}
    </>
  );
}

function ModelSection({ form }: { form: Form }) {
  const row = { form, scope: GLOBAL } as const;
  const on = form.shown(GLOBAL, 'scorer.model').written;
  const fallbacks = form.shown(GLOBAL, 'model.fallbacks').value;
  const tool = form.shown(GLOBAL, 'model.toolChoice').value;
  const scorerText = form.shown(GLOBAL, 'scorer.model').value;
  return (
    <section id="model" aria-labelledby="model-title" className={SECTION}>
      <h2 id="model-title" className={`${H2} mb-1`}>
        Model
      </h2>
      <Row {...row} path="model.baseUrl" id="l-url" labelFor="m-url" label={LABELS['model.baseUrl']!} help="An OpenAI-compatible endpoint. Its key is a secret, set in the environment.">
        <TextField form={form} scope={GLOBAL} path="model.baseUrl" id="m-url" className={`${MONO} w-full`} />
      </Row>
      <Row {...row} path="model.model" id="l-model" labelFor="m-model" label={LABELS['model.model']!} help="Tried first for every review.">
        <TextField form={form} scope={GLOBAL} path="model.model" id="m-model" className={MONO} />
      </Row>
      <Row {...row} path="model.fallbacks" id="l-fall" label={LABELS['model.fallbacks']!} help="Tried in this order when the model fails.">
        <Chips
          label="Fallbacks"
          addLabel="Add a model"
          values={Array.isArray(fallbacks) ? fallbacks.filter((item): item is string => typeof item === 'string') : []}
          onChange={(next) => form.set(GLOBAL, 'model.fallbacks', next)}
        />
      </Row>
      <Row {...row} path="model.effort.default" also={['model.effort.elevated']} id="l-effort" label="Effort" help="Elevated is used for pull requests into a primary branch.">
        <Effort form={form} path="model.effort.default" label="Default" />
        <Effort form={form} path="model.effort.elevated" label="Elevated" />
      </Row>
      <Row {...row} path="model.toolChoice" id="l-tool" label={LABELS['model.toolChoice']!} help="Auto is for a model whose endpoint refuses a request that names a tool.">
        <Segmented
          label="How the answer is asked for"
          options={[{ value: 'forced', label: 'Forced' }, { value: 'auto', label: 'Auto' }]}
          value={tool === 'forced' || tool === 'auto' ? tool : null}
          onChange={(next) => form.set(GLOBAL, 'model.toolChoice', next)}
        />
      </Row>
      <Row {...row} path="model.timeoutSeconds" id="l-time" labelFor="m-time" label={LABELS['model.timeoutSeconds']!} help="Seconds.">
        <NumberField form={form} scope={GLOBAL} path="model.timeoutSeconds" id="m-time" className="max-w-[140px]" />
      </Row>
      <Row {...row} path="model.prices" id="l-prices" label={LABELS['model.prices']!} help="Used only when the endpoint reports no cost.">
        <Prices form={form} />
      </Row>
      <Row
        {...row}
        path="scorer.model"
        id="l-scorer"
        label={LABELS['scorer.model']!}
        restart="On or off: needs a restart"
        waits={form.view.scorer.waits}
        help="A model of its own that scores the blocks. When it fails, the review keeps its findings."
      >
        <Switch
          checked={on}
          labelledBy="l-scorer"
          onChange={(next) => {
            if (!next) {
              for (const path of SCORER_PATHS) form.set(GLOBAL, path, UNSET);
              return;
            }
            // On again reads as the view has it; a scorer the view has off is written with the text typed, if any.
            form.drop(GLOBAL, SCORER_PATHS);
            if (!form.view.global['scorer.model']?.written) form.set(GLOBAL, 'scorer.model', typeof scorerText === 'string' ? scorerText : '');
          }}
        />
        <TextField form={form} scope={GLOBAL} path="scorer.model" label="Scorer model" disabled={!on} className={`${MONO} min-w-0 flex-[1_1_200px]`} />
      </Row>
      {on ? (
        <>
          <Row
            {...row}
            path="scorer.baseUrl"
            id="l-surl"
            labelFor="s-url"
            label={LABELS['scorer.baseUrl']!}
           
            help="The scorer's API. Its key is a secret, set in the environment."
          >
            <TextField form={form} scope={GLOBAL} path="scorer.baseUrl" id="s-url" className={`${MONO} w-full`} />
          </Row>
          <Row {...row} path="scorer.timeoutSeconds" id="l-stime" labelFor="s-time" label={LABELS['scorer.timeoutSeconds']!} help="Seconds, for one scorer call.">
            <NumberField form={form} scope={GLOBAL} path="scorer.timeoutSeconds" id="s-time" className="max-w-[140px]" />
          </Row>
        </>
      ) : null}
      <Row {...row} path="model.extraBody" id="l-body" labelFor="m-body" label={LABELS['model.extraBody']!} help="JSON fields merged into every request to the model.">
        <JsonField form={form} scope={GLOBAL} path="model.extraBody" id="m-body" />
      </Row>
      <Row
        {...row}
        path="model.extraHeaders"
        id="l-headers"
        labelFor="m-headers"
        label={LABELS['model.extraHeaders']!}
        help="JSON: each header's name and value, sent with every request to the model. A value here is shown, recorded and exported."
      >
        <JsonField form={form} scope={GLOBAL} path="model.extraHeaders" id="m-headers" />
      </Row>
    </section>
  );
}

const SECRETS: Readonly<Record<SecretKind, string>> = {
  model_key: 'Model key',
  scorer_key: 'Second scorer key',
  app_private_key: 'GitHub App private key',
  webhook_secret: 'Webhook secret',
  app_client_secret: 'GitHub App client secret',
  database: 'Database',
  audit_key: 'Audit key',
  alert_webhook: 'Alert webhook',
  extension: 'Extension',
  mcp_header: 'MCP server',
};

function SecretLine({ secret }: { secret: SecretState }) {
  const name = secret.of === null ? SECRETS[secret.kind] : `${SECRETS[secret.kind]} ${secret.of}`;
  return (
    <div data-slot="secret-row" className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-3 text-sm first-of-type:border-t-0">
      <span>
        {name}
        {secret.variable === null ? null : (
          <>
            {' '}
            <span className={`${MONO} text-muted`}>{secret.variable}</span>
          </>
        )}
      </span>
      {secret.variable === null ? (
        <Badge tone="muted">{secret.kind === 'alert_webhook' ? 'Not set, alerts are shown here only' : 'Not set'}</Badge>
      ) : (
        <Badge tone="ok">Set</Badge>
      )}
    </div>
  );
}

function Secrets({ secrets }: { secrets: readonly SecretState[] }) {
  return (
    <section id="secrets" aria-labelledby="secrets-title" className={`${SECTION} gap-2`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="secrets-title" className={H2}>
          Secrets
        </h2>
        <span className={WORD}>Read from the environment at start. Never shown or changed here.</span>
      </div>
      <div>
        {secrets.map((secret) => (
          <SecretLine key={`${secret.kind}/${secret.of ?? ''}`} secret={secret} />
        ))}
      </div>
    </section>
  );
}

function Access({ access }: { access: SettingsView['access'] }) {
  const none = <span className={WORD}>None</span>;
  return (
    <section id="access" aria-labelledby="access-title" className={SECTION}>
      <h2 id="access-title" className={`${H2} mb-1`}>
        Access
      </h2>
      <PlainRow id="l-address" label="Address" help="Where people open the service. Set in config.yml.">
        <span className={MONO}>{access.publicUrl}</span>
      </PlainRow>
      {access.github ? (
        <>
          <PlainRow
            id="l-team"
            label="Team that may sign in through GitHub"
            help="Its active members may sign in through the GitHub App, as viewers until an admin says otherwise. Set in config.yml."
          >
            {access.team === null ? none : <span className={MONO}>{access.team}</span>}
          </PlainRow>
          <PlainRow id="l-logins" label="Accounts that may sign in through GitHub" help="GitHub logins named in config.yml, beside the team.">
            {access.accounts.length === 0
              ? none
              : access.accounts.map((login) => (
                  <span key={login} className={CHIP}>
                    {login}
                  </span>
                ))}
          </PlainRow>
        </>
      ) : (
        <p className="border-t border-border py-4 text-sm text-muted">Sign-in through GitHub is off: config.yml names neither accounts nor a team.</p>
      )}
    </section>
  );
}

// -- the page -------------------------------------------------------------------------------------------------------------------

/** The sections' links, each to the section the page has. */
function Nav() {
  return (
    <nav aria-label="Settings sections" className="flex flex-wrap gap-2">
      {NAV.map(([id, name]) => (
        <Button key={id} asChild>
          <a href={`#${id}`}>{name}</a>
        </Button>
      ))}
    </nav>
  );
}

export function SettingsPage() {
  const { api, me } = useApp();
  // The latest read of the settings; a failed one drops what was shown.
  const [read, setRead] = useState<{ view: SettingsView | null; failed: boolean }>({ view: null, failed: false });
  const [reads, setReads] = useState(0);
  // Bumped after each save, and when a save met a change made meanwhile: the record and the export are read again.
  const [recorded, setRecorded] = useState(0);
  const [draft, setDraft] = useState<Draft>(new Map());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saved, setSaved] = useState(false);
  const [sending, setSending] = useState(false);
  const [badJson, setBadJson] = useState<ReadonlySet<string>>(new Set());
  const [epoch, setEpoch] = useState(0);
  const inFlight = useRef(false);

  useEffect(() => {
    let live = true;
    api.settings().then(
      (view) => {
        if (live) setRead({ view, failed: false });
      },
      () => {
        if (live) setRead({ view: null, failed: true });
      },
    );
    return () => {
      live = false;
    };
  }, [api, reads]);

  const view = read.view;
  const changes = view === null ? [] : changesOf(view, draft);
  // What is unsaved: each setting that differs from the view, and each JSON field whose text is not valid yet (it writes nothing).
  const unsavedCount = new Set([...changes.map((change) => keyOf(change.scope, change.path)), ...badJson]).size;
  const badNow = useRef(badJson);
  badNow.current = badJson;

  const form: Form | null =
    view === null
      ? null
      : {
          view,
          draft,
          epoch,
          bad: badJson,
          drop: (scope, paths) =>
            setDraft((last) => {
              const next = new Map(last);
              for (const path of paths) next.delete(keyOf(scope, path));
              return next;
            }),
          // A setting the draft takes back is not written: the view's old value is not its default, so it shows as none.
          shown: (scope, path) => {
            const now = shown(view, draft, scope, path);
            return isUnset(draft.get(keyOf(scope, path)) ?? null) && !now.written && (scope === GLOBAL || scope === DEFAULTS) ? { ...now, value: null } : now;
          },
          set: (scope, path, value) => {
            setDraft((last) => withChange(last, scope, path, value));
            setSaved(false);
          },
          issuesAt: (scope, path) =>
            notice?.kind === 'issues' ? notice.issues.filter((issue) => issue.scope === scope && issue.path === path).map((issue) => issue.message) : [],
          setBadJson: (key, bad) =>
            setBadJson((last) => {
              if (last.has(key) === bad) return last;
              const next = new Set(last);
              if (bad) next.add(key);
              else next.delete(key);
              return next;
            }),
        };

  function discard(): void {
    setDraft(new Map());
    setBadJson(new Set());
    setNotice(null);
    setSaved(false);
    setEpoch((n) => n + 1);
  }

  async function save(): Promise<void> {
    if (view === null || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setNotice(null);
    setSaved(false);
    const sentDraft = draft;
    try {
      const answer = await api.saveSettings(me.csrf, { version: view.version, changes });
      if (answer.kind === 'saved') {
        setRead({ view: answer.view, failed: false });
        // What was typed while the request was out is kept: an entry the draft still holds as it was sent was saved.
        setDraft((last) => new Map([...last].filter(([key, value]) => sentDraft.get(key) !== value)));
        if (badNow.current.size === 0) setEpoch((n) => n + 1);
        setSaved(true);
        setRecorded((n) => n + 1);
      } else {
        setNotice({ kind: 'issues', issues: answer.issues });
      }
    } catch (error) {
      // A 401 has signed the person out already, a 403 has the app read who is signed in (its watched API).
      if (error instanceof RequestFailed && error.code === 'changed') {
        setNotice({ kind: 'text', text: CHANGED });
        setReads((n) => n + 1);
        setRecorded((n) => n + 1);
      } else {
        setNotice({ kind: 'text', text: failureOf(error) });
      }
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  const unsaved = unsavedCount === 0 ? 'No unsaved changes' : plural(unsavedCount, 'unsaved change', 'unsaved changes');
  const body = (): ReactNode => {
    if (form === null) {
      if (read.failed) {
        return (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted">The settings could not be read.</p>
            <Button
              type="button"
              onClick={() => {
                setRead({ view: null, failed: false });
                setReads((n) => n + 1);
              }}
            >
              Try again
            </Button>
          </div>
        );
      }
      return <p className="text-sm text-muted">Reading the settings.</p>;
    }
    return (
      <>
        <General form={form} />
        <ModelSection form={form} />
        <RepositoriesSection form={form} issues={notice?.kind === 'issues' ? notice.issues : []} />
        <Secrets secrets={form.view.secrets} />
        <Access access={form.view.access} />
      </>
    );
  };

  return (
    <>
      <PageHeader title="Settings" sub={SUB}>
        {view === null ? null : (
          <div className="flex flex-wrap items-center gap-2.5">
            {saved ? (
              <span role="status" className="text-[13px] text-muted">
                Saved.
              </span>
            ) : null}
            <span className="text-[13px] text-muted">{unsaved}</span>
            <Button type="button" disabled={unsavedCount === 0} onClick={discard}>
              Discard
            </Button>
            <Button type="button" variant="primary" disabled={changes.length === 0 || sending || badJson.size > 0} onClick={() => void save()}>
              {sending ? 'Saving' : 'Save changes'}
            </Button>
          </div>
        )}
      </PageHeader>
      {notice === null ? null : (
        <div role="alert" className="rounded-[12px] border border-border bg-bad-bg px-5 py-3 text-sm text-bad">
          {notice.kind === 'text' ? (
            notice.text
          ) : (
            <>
              <p className="m-0">Not saved. Each issue is shown at its setting:</p>
              <ul className="m-0 mt-1 pl-5">
                {notice.issues.map((issue, index) => (
                  <li key={index}>
                    {issue.scope !== null && issue.path !== null
                      ? `${whereOf(issue.scope, issue.path)}, ${LABELS[issue.path] ?? issue.path}: ${issue.message}`
                      : issue.message}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <Nav />
      {body()}
      <AccountsSection />
      <ChangesSection reads={recorded} />
      <ExportSection reads={recorded} />
    </>
  );
}
