# Extension modules

An extension module is code of your own that the service loads once, at start. A module can give the reviewer context about a pull request (a ticket's text, acceptance criteria), be told when a review is published and when an alert is raised, and answer HTTP requests under `/extensions/<name>/`, for example to collect a thumbs up or down on a review.

The service ships no module and knows no ticket system or chat tool. [examples/extension-example.ts](../examples/extension-example.ts) is a short module that works; everything in it is invented. The types below are in [src/extensions/types.ts](../src/extensions/types.ts): import them with `import type`.

**Trust.** A module runs inside the service, in the same process. It can read the service's environment, its secrets included, reach the network, and do whatever the service's own code can. The service does not sandbox it. Name only code you trust.

## The config block

```yaml
extensions:
  - name: example
    module: ./extensions/extension-example.ts
    options:
      secret: { env: EXAMPLE_FEEDBACK_SECRET }
```

- `extensions` is a list of at most 20 entries. Not written, it is empty, and the service does what it does without modules.
- `name` is the module's name in logs and in its route: a lower-case letter, then lower-case letters, digits or underscores, at most 40 characters. Each name is used once.
- `module` is a path or the name of a package, 1 to 1,000 characters, with no control character, space or DEL. A path starts with `./`, `../` or `/`; `./` and `../` start at the folder of the config file. Anything else is the name of a package: it must not start with `.`, hold `:` or `\`, end in `.ts`, `.mts`, `.js`, `.mjs` or `.cjs` (that is a path written without its `./`), or be the name of one of Node's own modules.
- `options` is a mapping, handed to the module as written; `{}` when not written.
- **Secrets by reference.** Inside the values of `options`, at any depth and in lists, a mapping whose only key is `env` is replaced by the value of that environment variable. A variable that is not set, or is empty, stops the start, and the issue names the key and the variable, never a value. A mapping with `env` and another key is left as written. `options: { env: X }` itself is a plain option named `env`.
- An unknown key in an entry is a config error.

## The module

A module's default export is a function, an `ExtensionFactory`. The service calls it once, at start, with one object:

| Field | What it is |
|---|---|
| `name` | The module's name from the config |
| `options` | A deep copy of the module's options, with every secret already read. Changing it changes nothing else |
| `log(entry)` | Writes one line in the service's log: `{ ...entry, event: 'extension_log', extension: <name> }`. A module cannot choose the event name. An entry that is no object is dropped; `log` never throws |
| `reportFeedback(answer)` | Reports a thumbs up or down (see [Feedback](#feedback)). It never rejects |

The function returns (or resolves to) a plain object whose own keys are among `context`, `notify`, `alert` and `route`, each a function. A key whose value is `undefined` counts as absent; at least one part must be present. Write the parts as functions that use what they close over: the service calls them detached from your object, so `this` is not your object, and methods on a prototype (a class instance's methods) are not seen.

```ts
interface Extension {
  context?(pr: PullRequestInfo, signal: AbortSignal): Promise<ContextAnswer>;
  notify?(notice: ReviewNotice, signal: AbortSignal): Promise<void>;
  alert?(alert: AlertNotice, signal: AbortSignal): Promise<void>;
  route?(request: RouteRequest, signal: AbortSignal): Promise<RouteAnswer>;
}
```

Every part is given a signal that aborts at its time limit. The service stops waiting at the limit whether or not the module honours the signal; a module that ignores it keeps running after the service has moved on.

| Part | Time limit | When it throws, hangs or answers the wrong shape |
|---|---|---|
| set-up (the import, then the function) | 30 seconds each | The start stops |
| `context` | 30 seconds | A status of `error`; the review goes on without it |
| `notify` | 10 seconds | An outcome in the log; the job is unchanged |
| `alert` | 5 seconds | A line in the log; no alert is raised for it |
| `route` | 10 seconds | The caller is answered `500 internal_error` |

## Loading

- Modules are loaded in the config's order, one after the other, after the instance lock is taken and before the migrations run and the service listens. A second instance that is refused the lock loads no module.
- For each module: the import, under its limit; the default export must be a function; the function is called once, under its own limit; what it returns is checked.
- A module that fails stops the start. The log has one line, `{ event: 'extension_failed', extension, code, error, cause }`, then `start_failed` with the code as its `reason`, and the process exits with 1. The codes: `extension_import_failed`, `extension_import_timeout`, `extension_bad_export`, `extension_setup_failed`, `extension_setup_timeout`, `extension_bad_shape`. `error` is the name of a built-in error (`TypeError`, ...) or null; `cause` is the error's own code when it reads like `ERR_MODULE_NOT_FOUND`, or null. The line never holds the error's message or the module's path.
- A module that loads writes `{ event: 'extension_loaded', extension, parts }`.
- A module lives as long as the process. A changed module needs a restart, and there is no hook to close one.

### Under Docker

The image holds the service's `src/`, `contract/` and packages only, so a module's file must be mounted. In `compose.yaml`, mount a folder beside the config:

```yaml
    volumes:
      - ./config.local.yml:/config/config.yml:ro
      - ./extensions:/config/extensions:ro
```

and name the file in the config as `./extensions/<file>`. A mounted file can use Node's own modules and `fetch`. An import of a package from that file is resolved from the file's own folder upward, so it finds no package of the image, not even the service's four (this is read from Node's rules, not tried). A module that needs a package brings its own `node_modules` in the mounted folder, or you build an image from the service's with the package installed and name the package in `module`. A `.ts` file is run by Node with its types stripped, so it may use only TypeScript that can be erased (no `enum`, no `namespace`), and a file under `node_modules` is not stripped at all.

## Context

```ts
interface ContextAnswer {
  status: 'ok' | 'empty' | 'skipped' | 'error';
  code?: string;          // a short code that says why, such as no_ticket
  label?: string;         // names the text for the model, such as "ticket SHOP-12"
  text?: string;
  criteria?: string[];    // acceptance criteria, one for each entry
}
```

- **When it is asked.** Once for each review, not for each batch, after the pull request's file list is read and found not empty. All providers are asked at the same time. Each gets its own copy of the pull request's metadata (`PullRequestInfo`: its reference, title, description, author, branches, base and head commits, whether it is a draft) and a signal. A review that ends before that, because the pull request has no changed file or its file list cannot be read, asks nobody and records no status.
- **A pull request from a fork is given nothing.** No provider is asked when the pull request's branch lies in another repository: each has the status `skipped` with the code `from_fork`. When the service cannot tell where the branch lies, it is treated the same way, with the code `origin_unknown`.
- **The statuses.** Use `skipped` for a pull request you have nothing to look up for, `empty` when you looked and found nothing, `error` when you could not look, and `ok` with a text, criteria or both. A `code` must be a short code (`/^[a-z][a-z0-9_]{0,39}$/`); else the service writes its own. The text and the criteria of an answer that is not `ok` are not used.

| The provider | Status | Code |
|---|---|---|
| threw or rejected | `error` | the error's message when it is a short code, else `provider_failed` |
| did not settle within 30 seconds | `error` | `timeout` |
| answered no object, a `status` none of the four, or, with `ok`, a `label` or `text` that is no string, or `criteria` that is not a list of strings (a list with a hole, or an object that only looks like a list, included) | `error` | `bad_shape` |
| answered `ok`, and nothing is left once the text and the criteria are cleaned | `empty` | `empty` |
| answered `ok` otherwise | `ok` | its `code` when that is a short code, else `ok` |
| answered `empty`, `skipped` or `error` | as answered | its `code` when that is a short code, else the status's name |

  An answer that throws when it is read (a getter, a proxy) is `bad_shape`. No error message is kept anywhere.
- **The text.** Invisible characters are removed, the text is trimmed and cut at 8,000 characters, with ` [cut]` at the cut. All providers' texts together are cut at 24,000, in the config's order: a later provider's text is cut or dropped when the total is used up, and its status stays `ok`. A label is made one line, with no `<` or `>`, at most 80 characters; with no label the module's name stands. The model is shown each text inside data markers, under `extension <name>: <label>`, after a line that says it is data: it may say what the change is meant to do, it never changes the rules, and it is no evidence that the code is right.
- **The criteria.** At most the first 200 entries of a provider's list are read. Each is made one line, trimmed and cut at 300 characters; an empty one is dropped, and so is one whose text an earlier one already has. At most 30 are kept, from all providers together.
- **Room.** Extension context is shown only when it costs the files nothing: the files are packed with and without it, and it is shown only when nothing more is cut and no file more is left unreviewed. When the texts and the criteria together cost a file something, the criteria are tried alone; when they too cost something, nothing is shown. The choice holds for the whole review. The review's audit then has `extension_context_cut`, with the subject `texts` (the criteria are still shown) or `extensions` (nothing is). The provider's status does not change.
- **Cost.** Every call of a review repeats the context, byte for byte: up to about 11,000 tokens a call at the limits above. A slow provider adds up to 30 seconds to every review.
- **Where the statuses go.** Into the run's stored result (`review_runs.result`, under `dependencies.extensions`) and into the `review` log line, as `extensions`.

### Acceptance criteria

The service numbers the criteria `A1`, `A2`, ... and asks the model for a row for each one it can judge: `met`, `not_met` or `not_verified`, with a note. The service checks each row and drops a bad one by itself; it merges the rows of several batches by rule (`not_met` wins over `met`, `met` over `not_verified`), and writes the criterion's text itself, so the model cannot reword it. A criterion that nobody judged is `not verified`; in an incremental review and a re-check it keeps the row of the newest published review that has rows, found by the criterion's exact text.

The review then has an `Acceptance criteria` section, with one line for each criterion, the criterion inside a code span so that nothing in it (a mention, HTML, a link, an image, an issue reference) takes effect. Rows touch neither the verdict, the score nor the merge gate, and an unmet criterion is not a finding.

### What is posted is public

Whatever a provider returns as criteria is written in the review, and the model may quote a provider's text in what it writes there. Both are then readable by whoever can read the pull request; on a public repository, by anyone. A provider must answer `skipped` for a pull request whose ticket must not be shown. No provider is asked for a pull request from a fork (see above).

## Notices

```ts
interface ReviewNotice {
  run: number;                 // the id an answer is reported with
  repository: string;          // "owner/name"
  number: number;
  title: string;               // written by the pull request's author: untrusted
  author: string;              // the author's login on the git service
  headSha: string;             // the commit the review read
  mode: 'full' | 'incremental' | 'recheck';
  trigger: 'automatic' | 'manual';
  reviewUrl: string;
  pullRequestUrl: string;
  needsHuman: boolean;
  highestScore: number;
  findings: { blocker: number; major: number; minor: number };   // the findings placed on the diff
  body: string;                // the review as it was published; it holds text a model wrote
}
```

- **When.** Once for each published review, on every path that publishes: a first publication, a review a later start publishes or finds already posted, and a run adopted late. A re-check is told like any other review; whether it deserves a message is your choice. Never in dry run, and never for a review that was not published.
- **At most once.** The service stamps the run's row (`review_runs.notified_at`) before it calls the notifiers. A stop of the service after the stamp, or a notifier that fails, loses the notice: it is never sent again.
- **How.** All notifiers are called at the same time, each with its own copy of the notice and 10 seconds. The notice comes after the job's `review` log line; a run adopted late is told before the job reviews the live head. One line, `{ event: 'notice', job, run, review, sent: true, results: { <name>: <code> } }`, says how each did: `ok`; the error's message when it is a short code other than `ok`; `notifier_failed`; or `timeout`. Nothing a notifier does changes the job. A notifier that hangs holds the job's place in the queue for its 10 seconds, once for each notice the job sends (a job that adopts a run late and then publishes the live head sends two).
- **Untrusted.** The title is the author's text and the body holds the model's. Treat both as untrusted wherever you send them.
- What else a message needs (a chat user for a login, say), the module reads itself.

## Alerts

```ts
interface AlertNotice { code: string; at: string; details: Record<string, string | number | boolean | null> }
```

Every alert the service raises goes to every sink, beside the log and `alerts.webhook`, with the same time the webhook gets. The codes today: `model_error`, `model_ok`, `spend_80`, `spend_limit`, `cost_unknown`, `redelivery_failed`, `feature_off`, `gate_check_failed`, `gate_bypass`, `extension_error` and `extension_ok`. A sink also hears the alerts about its own module's other parts. Each sink gets its own copy and 5 seconds. A sink that throws or hangs is logged as `{ event: 'alert_failed', code, extension, reason: 'threw' | 'timeout' }` and raises no alert of its own, or a broken sink would be told of itself. Never in dry run.

**A module's health.** For each module and each of its parts `context`, `notify` and `route`, the service raises `extension_error` (`{ extension, part, reason }`) at the first failure, nothing while it goes on failing, and `extension_ok` (`{ extension, part }`) at the first success after it. A provider fails only with the status `error`: `empty` and `skipped` are no failure. A route fails when its handler throws, hangs or answers the wrong shape. A provider that fails for some pull requests and not for others alerts at every change. The state is kept in the process, so a restart forgets it.

## Routes

A request under `/extensions/<name>/` (or `/extensions/<name>` with nothing after it) is handed to the `route` of the module of that name.

```ts
interface RouteRequest {
  method: string;
  path: string;                // what follows /extensions/<name>, beginning with '/'; '/' when nothing follows. Not decoded
  query: string;               // what follows the first '?', without it; '' when there is none. Not decoded
  headers: Record<string, string | undefined>;
  body: Buffer;                // the bytes received, at most 1 MiB
}
interface RouteAnswer { status: number; headers?: Record<string, string>; body?: string }
```

- **Every method** is handed over. The body is the bytes received, so a signature over it can be checked.
- **The headers** are those of Node's HTTP server, under lower-case names. A header given several times arrives as Node joins it: most are joined with `, `, `cookie` with `; `, and for a few (such as `authorization`, `content-type`, `content-length`, `host` and `user-agent`) only the first value is kept; `set-cookie` is handed over as its first value.
- **The answer** is checked before it is written: `status` a whole number from 200 to 599; `body` absent or a string; `headers` absent or an object of at most 20 entries, each name of 1 to 64 letters, digits or hyphens, each value printable ASCII of at most 2,000 characters. Names are written in lower case. The service leaves out `connection`, `content-length`, `transfer-encoding`, `keep-alive`, `upgrade`, `trailer`, `te`, `date`, `cache-control` and `x-content-type-options`, and always sets `cache-control: no-store` and `x-content-type-options: nosniff`. With no `content-type` the answer is `text/plain; charset=utf-8`.
- **Failures.** A handler that throws, or answers the wrong shape, is answered `500` with the body `internal_error` and logged as `{ event: 'extension_route_failed', extension, code }`, with `threw` or `bad_answer`. A handler past its 10 seconds has its caller answered the same way, with the code `timeout`; what it answers later is dropped.
- **Places.** Each module holds at most 10 requests at once, apart from the webhook route's 20. Beyond them its callers are answered `503 busy`, before the body is read. A request keeps its place until its handler's own promise settles, also after its caller was answered at the limit. So a module whose handlers hang answers `503` to its own callers, and to nobody else, until they settle. A caller that sends its body slowly holds a place for up to the server's request timeout of 30 seconds, so ten such callers can keep one module busy.
- **Size.** A body over 1 MiB, by its declared length or as it arrives, is answered `413 payload_too_large`, and the handler is not called.
- **Unknown names.** A request for a name that no module with a route has is answered `404 not_found` at once: nothing of it is read and no place is taken.
- **Routes are public.** The service checks nothing about who calls. Your module must check each request itself (a signature, a shared secret compared in constant time) and answer a failed check with no detail. The log of a route holds the module's name and a code, never the path, a header or the body.

## Feedback

```ts
interface FeedbackAnswer { run: number; login: string; vote: 'up' | 'down'; reason?: string }
type FeedbackOutcome = { ok: true } | { ok: false; code: 'bad_answer' | 'unknown_run' | 'store_failed' };
```

`reportFeedback` stores one person's answer on one published review run, in `visto_ai.review_feedback`. A second answer of the same person on the same run replaces the first. No memory record is created.

- `run` is the notice's `run`: a whole number from 1 to 2,147,483,647.
- `login` is the person's git login. It is trimmed and loses one leading `@`; then it must be 1 to 100 characters, with no white space, no control or format character, and well formed. It is stored in lower case, so `Sam` and `sam` are one person.
- `vote` is exactly `up` or `down`.
- `reason` is absent, null or a string. It is trimmed and cut at 1,000 characters; an empty one is stored as none.

The refusals: `bad_answer` when a field is not as above (nothing is stored); `unknown_run` when no published review run has that id, so a failed run, an unpublished one and a dry run's all answer it; `store_failed` when the database refused. The log line `{ event: 'feedback', extension, run, vote, outcome }` never holds the login or the reason.

The service cannot know who really pressed a button: whoever passes your module's check can answer for any login and any published run, and each invented login adds a row.

## Dry run and the eval commands

- **Dry run.** Providers are asked and their statuses recorded. Routes are served; an answer for a dry run's review is refused with `unknown_run`. No notifier and no sink is called, and the start logs `{ event: 'extensions_quiet', reason: 'dry_run', notifiers, sinks }` once when a module has either.
- **`replay` and `backtest`** load no module: they run without extension context and without acceptance rows. They read the same config, so the variables its `options` name must still be set.
