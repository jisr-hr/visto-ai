// Loads the deployment's extension modules once, at start (section 11.3). Outside the engine: the engine is handed
// context providers through ReviewDeps and never sees a module.
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionConfig } from '../config/load.ts';
import type { ContextProvider } from '../engine/types.ts';
import { withLimit } from './limit.ts';
import type { Extension, ExtensionSetup, FeedbackAnswer, FeedbackOutcome, LoadedExtension } from './types.ts';

export const SETUP_TIMEOUT_MS = 30_000;

const PARTS = ['context', 'notify', 'alert', 'route'] as const;
type Part = (typeof PARTS)[number];

/** A failure of a module's own (its import or its set-up), told apart from the limit's timeout whatever the module threw. */
class ModuleError {
  readonly error: unknown;
  constructor(error: unknown) { this.error = error; }
}
class LoadFailure {
  readonly code: string;
  readonly error: unknown;
  constructor(code: string, error: unknown = null) { this.code = code; this.error = error; }
}

const BUILT_IN_ERRORS = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError', 'AggregateError']);

/** A field of a thrown error that is safe to log: a built-in error's name, or a code of Node's style. Never a message, never free text. */
function safeField(error: unknown, key: 'name' | 'code'): string | null {
  try {
    if (typeof error !== 'object' || error === null) return null;
    const value: unknown = (error as Record<string, unknown>)[key];
    if (typeof value !== 'string') return null;
    if (key === 'name') return BUILT_IN_ERRORS.has(value) ? value : null;
    return /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** The name of a thrown value when it is one of the platform's own error names, else null. Never throws. */
export function errorNameOf(error: unknown): string | null {
  return safeField(error, 'name');
}

function isPath(module: string): boolean {
  return module.startsWith('./') || module.startsWith('../') || module.startsWith('/');
}

function specifierOf(module: string, configDir: string): string {
  if (!isPath(module)) return module;
  return pathToFileURL(isAbsolute(module) ? module : resolve(configDir, module)).href;
}

/** The parts of what a factory returned, in the contract's order, or null when its shape is wrong. */
function partsOf(returned: unknown): Extension | null {
  try {
    if (typeof returned !== 'object' || returned === null || Array.isArray(returned)) return null;
    const source = returned as Record<string, unknown>;
    const parts: Partial<Record<Part, (...args: never[]) => unknown>> = {};
    for (const key of Reflect.ownKeys(source)) {
      if (typeof key !== 'string' || !(PARTS as readonly string[]).includes(key)) return null;
    }
    for (const part of PARTS) {
      if (!Object.hasOwn(source, part)) continue;
      const value = source[part];
      if (value === undefined) continue;
      if (typeof value !== 'function') return null;
      parts[part] = value as (...args: never[]) => unknown;
    }
    return Object.keys(parts).length === 0 ? null : (parts as Extension);
  } catch {
    return null;
  }
}

function setupFor(config: ExtensionConfig, deps: Parameters<typeof loadExtensions>[1]): ExtensionSetup {
  const name = config.name;
  return {
    name,
    options: structuredClone(config.options),
    log(entry: Record<string, unknown>): void {
      try {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return;
        deps.log({ ...entry, event: 'extension_log', extension: name });
      } catch {
        // A module's line that cannot be read or written is dropped.
      }
    },
    async reportFeedback(answer: FeedbackAnswer): Promise<FeedbackOutcome> {
      try {
        return await deps.reportFeedback(name, answer);
      } catch {
        return { ok: false, code: 'store_failed' };
      }
    },
  };
}

async function loadOne(config: ExtensionConfig, deps: Parameters<typeof loadExtensions>[1]): Promise<Extension> {
  const importModule = deps.importModule ?? ((specifier: string) => import(specifier));
  const limitMs = deps.setupTimeoutMs ?? SETUP_TIMEOUT_MS;
  let namespace: unknown;
  try {
    namespace = await withLimit(limitMs, async () => {
      try {
        return await importModule(specifierOf(config.module, deps.configDir));
      } catch (error) {
        throw new ModuleError(error);
      }
    });
  } catch (failure) {
    if (failure instanceof ModuleError) throw new LoadFailure('extension_import_failed', failure.error);
    throw new LoadFailure('extension_import_timeout');
  }
  let factory: unknown;
  try {
    factory = typeof namespace === 'object' && namespace !== null ? (namespace as { default?: unknown }).default : undefined;
  } catch (error) {
    throw new LoadFailure('extension_bad_export', error);
  }
  if (typeof factory !== 'function') throw new LoadFailure('extension_bad_export');
  const setup = setupFor(config, deps);
  let returned: unknown;
  try {
    returned = await withLimit(limitMs, async () => {
      try {
        return await (factory as (setup: ExtensionSetup) => unknown)(setup);
      } catch (error) {
        throw new ModuleError(error);
      }
    });
  } catch (failure) {
    if (failure instanceof ModuleError) throw new LoadFailure('extension_setup_failed', failure.error);
    throw new LoadFailure('extension_setup_timeout');
  }
  const parts = partsOf(returned);
  if (parts === null) throw new LoadFailure('extension_bad_shape');
  return parts;
}

/** Loads every module, in the order given, one after the other. Rejects at the first that fails, with Error(<code>), after one log line that names it. */
export async function loadExtensions(configs: ExtensionConfig[], deps: {
  configDir: string;                                   // the folder of the config file: a relative path starts there
  log: (entry: Record<string, unknown>) => void;
  reportFeedback: (extension: string, answer: FeedbackAnswer) => Promise<FeedbackOutcome>;
  importModule?: (specifier: string) => Promise<unknown>;   // for tests; absent: (s) => import(s)
  setupTimeoutMs?: number;                             // for tests; absent: SETUP_TIMEOUT_MS
}): Promise<LoadedExtension[]> {
  const loaded: LoadedExtension[] = [];
  for (const config of configs) {
    let parts: Extension;
    try {
      parts = await loadOne(config, deps);
    } catch (failure) {
      const known = failure instanceof LoadFailure ? failure : new LoadFailure('extension_setup_failed', failure);
      deps.log({
        event: 'extension_failed', extension: config.name, code: known.code,
        error: safeField(known.error, 'name'), cause: safeField(known.error, 'code'),
      });
      throw new Error(known.code);
    }
    deps.log({ event: 'extension_loaded', extension: config.name, parts: PARTS.filter((part) => parts[part] !== undefined) });
    loaded.push({ name: config.name, parts });
  }
  return loaded;
}

/** The modules that have the part, in their order, each with its name. */
export function contextProvidersOf(extensions: LoadedExtension[]): ContextProvider[] {
  return extensions.flatMap(({ name, parts }) => {
    if (parts.context === undefined) return [];
    return [{ name, provide: (pr, signal) => parts.context!(pr, signal) } satisfies ContextProvider];
  });
}
export function notifiersOf(extensions: LoadedExtension[]): Array<{ name: string; notify: NonNullable<Extension['notify']> }> {
  return extensions.flatMap(({ name, parts }) => (parts.notify === undefined ? [] : [{ name, notify: parts.notify }]));
}
export function alertSinksOf(extensions: LoadedExtension[]): Array<{ name: string; alert: NonNullable<Extension['alert']> }> {
  return extensions.flatMap(({ name, parts }) => (parts.alert === undefined ? [] : [{ name, alert: parts.alert }]));
}
