import { describe, expect, it } from 'vitest';
import { quitConfirm } from './quit-confirm';

describe('quitConfirm', () => {
  it('names how many Sessions are still working, in English', () => {
    expect(quitConfirm('en', 3)).toEqual({
      message: '3 Sessions are still working. Quit anyway?',
      buttons: ['Quit', 'Cancel'],
    });
    expect(quitConfirm('en', 1).message).toBe('1 Session is still working. Quit anyway?');
  });

  it('speaks Spanish', () => {
    expect(quitConfirm('es', 2)).toEqual({
      message: '2 sesiones siguen trabajando. ¿Salir de todos modos?',
      buttons: ['Salir', 'Cancelar'],
    });
    expect(quitConfirm('es', 1).message).toBe('1 sesión sigue trabajando. ¿Salir de todos modos?');
  });
});
