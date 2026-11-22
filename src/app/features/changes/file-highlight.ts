import { codeToTokensWithThemes } from 'shiki';
import type { FileLanguage } from './file-language';

export interface HighlightToken {
  content: string;
  light: string | undefined;
  dark: string | undefined;
}

export async function highlight(content: string, lang: FileLanguage): Promise<HighlightToken[][]> {
  const lines = await codeToTokensWithThemes(content, {
    lang,
    themes: { light: 'github-light', dark: 'github-dark' },
  });
  return lines.map((line) =>
    line.map((token) => ({
      content: token.content,
      light: token.variants['light']?.color,
      dark: token.variants['dark']?.color,
    })),
  );
}
