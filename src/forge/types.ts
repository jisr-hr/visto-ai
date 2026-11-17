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
  /** The file's text on the repository's default branch; null when it is absent or is not text. */
  getDefaultBranchFile(pr: PullRequestInfo, path: string): Promise<string | null>;
}
