import type { NotificationCause } from '../../src/shared/sessions/sessions.rpc';

export interface AttentionCopy {
  readonly fallbackTitle: string;
  readonly body: (cause: NotificationCause) => string;
}

const EN: AttentionCopy = {
  fallbackTitle: 'New Session',
  body: (cause) => {
    switch (cause) {
      case 'blocked':
        return 'Waiting for your answer';
      case 'turnFinished':
        return 'Turn finished';
      case 'error':
        return 'Stopped with an error';
    }
  },
};

const ES: AttentionCopy = {
  fallbackTitle: 'Nueva Sesión',
  body: (cause) => {
    switch (cause) {
      case 'blocked':
        return 'Esperando tu respuesta';
      case 'turnFinished':
        return 'Turno finalizado';
      case 'error':
        return 'Se detuvo con un error';
    }
  },
};

/** Localized copy for Session notifications in main. */
export const attentionNotificationCopy = (locale: 'en' | 'es'): AttentionCopy =>
  locale === 'es' ? ES : EN;
