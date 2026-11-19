export type FileLanguage =
  | 'typescript'
  | 'javascript'
  | 'json'
  | 'markdown'
  | 'html'
  | 'css'
  | 'python'
  | 'shellscript'
  | 'yaml'
  | 'rust'
  | 'go'
  | 'docker';

const names: Readonly<Record<string, FileLanguage>> = {
  dockerfile: 'docker',
  '.gitignore': 'shellscript',
};
const extensions: Readonly<Record<string, FileLanguage>> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  css: 'css',
  py: 'python',
  sh: 'shellscript',
  yml: 'yaml',
  yaml: 'yaml',
  rs: 'rust',
  go: 'go',
};

export function fileLanguage(path: string): FileLanguage | undefined {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase();
  if (names[name] !== undefined) return names[name];
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? undefined : extensions[name.slice(dot + 1)];
}
