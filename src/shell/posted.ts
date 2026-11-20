import type { StoredComment } from '../db/review-comments.ts';
import type { InlineComment } from '../engine/render/body.ts';
import type { PostedComment } from '../forge/types.ts';

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Ties posted comments to the findings of the run that rendered them: same path, side and text; each rendered comment is used once. */
export function matchPosted(run: { result: unknown; comments: unknown }, posted: PostedComment[]): StoredComment[] {
  const result = run.result as { findings?: unknown } | null;
  const findings = asArray(result?.findings) as Array<{ severity: string; quote: string } | undefined>;
  const rendered = asArray(run.comments) as InlineComment[];
  const taken = new Set<number>();
  const matched: StoredComment[] = [];
  for (const c of posted) {
    const i = rendered.findIndex((r, index) => !taken.has(index) && findings[index] !== undefined
      && r.path === c.path && r.side === c.side && r.body === c.body);
    if (i < 0) continue;
    taken.add(i);
    matched.push({ commentId: c.id, path: c.path, side: c.side, line: c.line, severity: findings[i]!.severity, quote: findings[i]!.quote });
  }
  return matched;
}
