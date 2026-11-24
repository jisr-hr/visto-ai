// The one reader of a path's directory in the memory part. A leaf: it imports nothing, so every module of the memory part can use it.

/** 'src/a/b.ts' gives 'src/a'; 'b.ts' gives '.'. */
export function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '.' : path.slice(0, slash);
}
