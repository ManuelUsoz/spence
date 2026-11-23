import type { Attention } from '../../src/shared/sessions/sessions.rpc';

export interface AttentionCopy {
  readonly fallbackTitle: string;
  readonly body: (cause: Attention) => string;
}

const EN: AttentionCopy = {
  fallbackTitle: 'New Session',
  body: (cause) => (cause === 'blocked' ? 'Waiting for your answer' : 'Stopped with an error'),
};

const ES: AttentionCopy = {
  fallbackTitle: 'Nueva Sesión',
  body: (cause) => (cause === 'blocked' ? 'Esperando tu respuesta' : 'Se detuvo con un error'),
};

/** Localized copy for OS Attention notifications in main. */
export const attentionNotificationCopy = (locale: 'en' | 'es'): AttentionCopy =>
  locale === 'es' ? ES : EN;
