import type { FolderEntry } from '../../../shared/files/files.rpc';

const names: Readonly<Record<string, string>> = {
  'package.json': 'package',
  dockerfile: 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  'package-lock.json': 'lock',
  'npm-shrinkwrap.json': 'lock',
  'yarn.lock': 'lock',
  'pnpm-lock.yaml': 'lock',
  'bun.lock': 'lock',
  'bun.lockb': 'lock',
  '.gitignore': 'git',
  '.gitattributes': 'git',
};

const extensions: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  html: 'html',
  css: 'css',
  scss: 'css',
  md: 'markdown',
  markdown: 'markdown',
  yaml: 'config',
  yml: 'config',
  toml: 'config',
  xml: 'config',
  py: 'python',
  rs: 'rust',
  go: 'go',
  sh: 'terminal',
  bash: 'terminal',
  ps1: 'terminal',
  svg: 'image',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
};

/** Selects an icon from the entry name alone, identically for local and remote Sessions. */
export function fileIcon(name: string, kind: FolderEntry['kind'], open: boolean): string {
  if (kind === 'Dir') return open ? 'folder-open' : 'folder';
  const lower = name.toLowerCase();
  const known = Object.hasOwn(names, lower) ? names[lower] : undefined;
  if (known !== undefined) return known;
  if (lower === 'readme' || lower.startsWith('readme.')) return 'readme';
  if (lower === '.env' || lower.startsWith('.env.')) return 'env';
  const dot = lower.lastIndexOf('.');
  const extension = lower.slice(dot + 1);
  return dot > 0 && Object.hasOwn(extensions, extension)
    ? (extensions[extension] ?? 'file')
    : 'file';
}
