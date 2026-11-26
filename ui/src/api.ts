// The one way the frontend reaches data (UI design 3.1; calls 13 and 23): same-origin requests under /api/ that accept JSON; a
// change sends the token for changes in its header. An answer that is not ok rejects with its status and its short code.
import { useEffect, useRef, useState } from 'react';
import type { Activity, ApiError, Me, Reviews } from './api-types.ts';

/**
 * A request the API did not answer with success; not `ApiError`, which is the JSON type of the answer it carries. A request
 * that reached no answer is status 0, `network`; an ok answer that is not JSON keeps its status, `unreadable`.
 */
export class RequestFailed extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string) {
    super(`The request failed: ${status} ${code}.`);
    this.name = 'RequestFailed';
    this.status = status;
    this.code = code;
  }
}

export interface ReviewQuery { repo?: string; outcome?: 'approved' | 'needs_person' | 'failed'; q?: string; before?: number }
export interface Api {
  me(): Promise<Me>; activity(): Promise<Activity>; reviews(query: ReviewQuery): Promise<Reviews>; signOut(csrf: string): Promise<void>;
}

const CSRF_HEADER = 'x-visto-csrf';
/** A short code as the API writes one; anything else an answer carries reads as `unknown`. */
const SHORT_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** The code of a refusal: its ApiError's, else `unknown` (a body that is not one, such as the listener's plain `busy`). */
async function codeOf(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const code = typeof body === 'object' && body !== null ? (body as Partial<ApiError>).error : undefined;
    return typeof code === 'string' && SHORT_CODE.test(code) ? code : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function createApi(fetchFn?: typeof fetch): Api {
  // Called as a function of its own, never as a method of another object, which a browser's fetch refuses.
  const call: typeof fetch = fetchFn ?? ((input, init) => fetch(input, init));

  /** A network failure is status 0, `network`. */
  async function send(method: 'GET' | 'POST', path: string, headers: Record<string, string> = {}): Promise<Response> {
    let response: Response;
    try {
      response = await call(path, { method, credentials: 'same-origin', headers: { accept: 'application/json', ...headers } });
    } catch {
      throw new RequestFailed(0, 'network');
    }
    if (!response.ok) throw new RequestFailed(response.status, await codeOf(response));
    return response;
  }

  /** An ok answer that is not JSON is `unreadable`. */
  async function read<T>(path: string): Promise<T> {
    const response = await send('GET', path);
    try {
      return (await response.json()) as T;
    } catch {
      throw new RequestFailed(response.status, 'unreadable');
    }
  }

  return {
    me: () => read<Me>('/api/me'),
    activity: () => read<Activity>('/api/activity'),
    reviews(query) {
      const params = new URLSearchParams();
      // A value written empty is sent as none (the API reads an empty one as absent too).
      if (query.repo) params.set('repo', query.repo);
      if (query.outcome) params.set('outcome', query.outcome);
      if (query.q) params.set('q', query.q);
      if (query.before !== undefined) params.set('before', String(query.before));
      const search = params.toString();
      return read<Reviews>(search === '' ? '/api/reviews' : `/api/reviews?${search}`);
    },
    async signOut(csrf) {
      // 204, no body to read.
      await send('POST', '/api/auth/signout', { [CSRF_HEADER]: csrf });
    },
  };
}

interface Polled<T> { data: T | null; failed: boolean; error: RequestFailed | null }
const NONE = { data: null, failed: false, error: null } as const;

/**
 * Reads at once, then `ms` after each read ends, never while the page is hidden, and at once when it shows again; an `ms` not
 * above 0 reads once. The data is always the latest answer for `key`: a new key starts again from none and reads at once, and
 * an answer for an earlier key is dropped. A read that fails keeps the last answer and says it failed until one works; its
 * error is the `RequestFailed` it rejected with, or null for any other.
 */
export function usePoll<T>(read: () => Promise<T>, ms: number, key: string): Polled<T> {
  const [state, setState] = useState<Polled<T> & { key: string }>({ ...NONE, key });
  const latest = useRef(read);
  useEffect(() => {
    latest.current = read;
  });

  useEffect(() => {
    const repeats = Number.isFinite(ms) && ms > 0;
    let live = true;
    let reading = false;
    let reads = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const due = (): void => {
      clearTimeout(timer);
      timer = undefined;
      if (!live || reading || document.visibilityState === 'hidden') return;
      if (!repeats && reads > 0) return;
      reading = true;
      reads += 1;
      latest.current().then(
        (data) => {
          if (live) setState({ key, data, failed: false, error: null });
        },
        (error: unknown) => {
          if (live) {
            setState((last) => ({
              key, data: last.key === key ? last.data : null, failed: true, error: error instanceof RequestFailed ? error : null,
            }));
          }
        },
      ).finally(() => {
        reading = false;
        if (live && repeats && document.visibilityState !== 'hidden') timer = setTimeout(due, ms);
      });
    };
    const shown = (): void => {
      if (document.visibilityState !== 'hidden') due();
    };

    document.addEventListener('visibilitychange', shown);
    due();
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [key, ms]);

  if (state.key !== key) return NONE;
  return { data: state.data, failed: state.failed, error: state.error };
}
