import { describe, expect, it } from 'vitest';
import { fileIcon } from './file-icon-map';

describe('fileIcon', () => {
  it('matches names before extensions, ignoring case, and falls back for unknown files', () => {
    expect(fileIcon('PACKAGE.JSON', 'File', false)).toBe('package');
    expect(fileIcon('README.MD', 'File', false)).toBe('readme');
    expect(fileIcon('Dockerfile', 'File', false)).toBe('docker');
    expect(fileIcon('package-lock.json', 'File', false)).toBe('lock');
    expect(fileIcon('.gitignore', 'File', false)).toBe('git');
    expect(fileIcon('.env.local', 'File', false)).toBe('env');
    expect(fileIcon('example.test.TS', 'File', false)).toBe('typescript');
    expect(fileIcon('.unknown', 'File', false)).toBe('file');
    expect(fileIcon('unknown.xyz', 'File', false)).toBe('file');
    expect(fileIcon('src', 'Dir', false)).toBe('folder');
    expect(fileIcon('src', 'Dir', true)).toBe('folder-open');
  });
});
