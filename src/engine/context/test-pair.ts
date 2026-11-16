const TEST_DIR = /(^|\/)(spec|specs|test|tests|__tests__)\//;
const TEST_SUFFIX = /[._](spec|test)\.[a-z]+$/i;
const SCRIPT_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx'];

export function isTestPath(path: string): boolean {
  return TEST_DIR.test(path) || TEST_SUFFIX.test(path);
}

export function testCandidates(path: string): string[] {
  if (isTestPath(path)) return [];
  const dot = path.lastIndexOf('.');
  const extension = dot > path.lastIndexOf('/') ? path.slice(dot + 1) : '';
  if (extension === 'rb') {
    const stem = path.slice(0, -'.rb'.length);
    const withoutApp = stem.startsWith('app/') ? stem.slice('app/'.length) : stem;
    return [`spec/${withoutApp}_spec.rb`];
  }
  if (SCRIPT_EXTENSIONS.includes(extension)) {
    const slash = path.lastIndexOf('/');
    const dir = slash === -1 ? '.' : path.slice(0, slash);
    const base = path.slice(slash + 1, -(extension.length + 1));
    return [
      `${dir}/${base}.test.${extension}`,
      `${dir}/${base}.spec.${extension}`,
      `${dir}/__tests__/${base}.test.${extension}`,
    ];
  }
  return [];
}
