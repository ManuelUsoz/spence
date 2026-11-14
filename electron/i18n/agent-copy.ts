import type { AgentId } from '../../src/shared/agents/agents.rpc';
import type { Locale } from './locale';

export interface AgentLocalizedCopy {
  readonly upgradeCommand?: string;
  readonly installInstructions?: string;
  readonly loginInstructions?: string;
  readonly excludedNote?: string;
}

const EN: Readonly<Record<string, AgentLocalizedCopy>> = {
  antigravity: {
    upgradeCommand: 'Update Google Antigravity (`agy` 1.2+)',
    installInstructions:
      'Install Google Antigravity from antigravity.google so `agy` is on your PATH, then click Re-scan.',
    loginInstructions:
      'Sign in with your Google account in Google Antigravity, then click Log in or try again.',
    excludedNote: 'Third-party models in Antigravity are unavailable for Spence clients.',
  },
  codex: {
    loginInstructions:
      'Sign in with your ChatGPT account using Log in, or run `codex login` in a terminal and then Try again.',
  },
};

const ES: Readonly<Record<string, AgentLocalizedCopy>> = {
  antigravity: {
    upgradeCommand: 'Actualiza Google Antigravity (`agy` 1.2+)',
    installInstructions:
      'Instala Google Antigravity desde antigravity.google para que `agy` esté en tu PATH y luego haz clic en Volver a buscar.',
    loginInstructions:
      'Inicia sesión con tu cuenta de Google en Google Antigravity y luego haz clic en Iniciar sesión o intenta de nuevo.',
    excludedNote:
      'Los modelos de terceros en Antigravity no están disponibles para clientes de Spence.',
  },
  codex: {
    loginInstructions:
      'Inicia sesión con tu cuenta de ChatGPT usando Iniciar sesión, o ejecuta `codex login` en una terminal y luego haz clic en Intentar de nuevo.',
  },
};

/** Localized Catalog Agent instructions and notes in main. */
export const agentCopy = (locale: Locale, agentId: AgentId): AgentLocalizedCopy | undefined =>
  (locale === 'es' ? ES : EN)[agentId];
