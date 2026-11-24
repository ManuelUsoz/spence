import type { NotificationCause } from '../../src/shared/sessions/sessions.rpc';

export interface NotificationCopy {
  readonly fallbackTitle: string;
  readonly body: (cause: NotificationCause) => string;
}

const EN: NotificationCopy = {
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

const ES: NotificationCopy = {
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
export const sessionNotificationCopy = (locale: 'en' | 'es'): NotificationCopy =>
  locale === 'es' ? ES : EN;
