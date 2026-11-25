import type { ChangedFile } from '../types.ts';

// Files that hold credentials by convention. Nothing of such a file is ever sent to a model.
const SECRET_NAMES = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.netrc', '_netrc', '.npmrc', '.pypirc', '.dockercfg']);
const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template']);

/** A path is secret by its segments alone, compared case-insensitively. */
export function isSecretPath(path: string): boolean {
  const segments = path.toLowerCase().split('/').filter((s) => s !== '');
  const name = segments[segments.length - 1];
  if (name === undefined) return false;
  if (segments.includes('.ssh') || SECRET_NAMES.has(name)) return true;
  return (name === '.env' || name.startsWith('.env.')) && !ENV_TEMPLATES.has(name);
}

/** A changed file is secret when its path or the path it was renamed from is. */
export function isSecretFile(file: ChangedFile): boolean {
  return isSecretPath(file.path) || (file.previousPath !== null && isSecretPath(file.previousPath));
}
