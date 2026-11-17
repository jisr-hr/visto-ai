// src/forge/types.ts
export type Side = 'LEFT' | 'RIGHT';
export interface PullRequestRef { service: 'github'; owner: string; repo: string; number: number }
export interface PullRequestInfo {
  ref: PullRequestRef;
  title: string; description: string; author: string;
  baseBranch: string; headBranch: string;
  baseSha: string;            // the diff's base: the merge base with the base branch
  headSha: string;
  draft: boolean;
}
export type FileStatus = 'added' | 'modified' | 'removed' | 'renamed';
export interface ChangedFile {
  path: string; previousPath: string | null; status: FileStatus;
  additions: number; deletions: number;
  patch: string | null;       // null when the service sent none
}
export interface Source {
  listFiles(pr: PullRequestInfo): Promise<ChangedFile[]>;
  /** null when the file is absent at that commit or is not text */
  getFileContent(pr: PullRequestInfo, path: string, sha: string): Promise<string | null>;
  /** The file's text on the repository's default branch, whatever its bytes; null only when it is absent. */
  getDefaultBranchFile(pr: PullRequestInfo, path: string): Promise<string | null>;
}

export type Association = 'owner' | 'member' | 'collaborator' | 'none';
export interface RepoRef { owner: string; repo: string }
export interface MergedPullRequest {
  number: number; title: string; description: string; author: string; authorIsBot: boolean;
  baseBranch: string; headBranch: string; baseSha: string; headSha: string; mergedAt: string;
}
export interface HumanReview {
  id: string; author: string; authorIsBot: boolean; association: Association;
  state: 'approved' | 'changes_requested' | 'commented' | 'dismissed'; commit: string | null; at: string; body: string;
}
export interface HumanInlineComment {
  id: string; author: string; authorIsBot: boolean; association: Association; at: string;
  commit: string; path: string; side: Side; line: number | null; startLine: number | null; fileLevel: boolean; replyTo: string | null; body: string;
}
export interface GeneralComment { id: string; author: string; authorIsBot: boolean; association: Association; at: string; body: string }
export interface Comparison { mergeBase: string; files: ChangedFile[] }
export interface HistorySource {
  /** pageLimitReached: the listing ran out of pages, so older pull requests in the window may be missing. */
  listMergedPullRequests(
    repo: RepoRef, window: { since: string; until: string }, limit: number,
  ): Promise<{ pullRequests: MergedPullRequest[]; pageLimitReached: boolean }>;
  listReviews(repo: RepoRef, number: number): Promise<HumanReview[]>;
  listInlineComments(repo: RepoRef, number: number): Promise<HumanInlineComment[]>;
  listGeneralComments(repo: RepoRef, number: number): Promise<GeneralComment[]>;
  /** null when either commit can no longer be read */
  compare(repo: RepoRef, base: string, head: string): Promise<Comparison | null>;
}
