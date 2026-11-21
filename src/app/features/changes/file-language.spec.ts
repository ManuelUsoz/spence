import { describe, expect, it } from 'vitest';
import { fileLanguage } from './file-language';

describe('fileLanguage', () => {
  it('maps names and extensions without inspecting content', () => {
    expect(fileLanguage('Dockerfile')).toBe('docker');
    expect(fileLanguage('README.MD')).toBe('markdown');
    expect(fileLanguage('component.test.TS')).toBe('typescript');
    expect(fileLanguage('.gitignore')).toBe('shellscript');
    expect(fileLanguage('unknown.xyz')).toBeUndefined();
    expect(fileLanguage('.env.local')).toBeUndefined();
  });
});
