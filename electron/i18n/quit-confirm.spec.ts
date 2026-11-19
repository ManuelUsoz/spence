import { describe, expect, it } from 'vitest';
import { quitConfirm } from './quit-confirm';

describe('quitConfirm', () => {
  it('names how many Sessions are still working, in English', () => {
    expect(quitConfirm('en', { working: 3, viewers: 0 })).toEqual({
      message: '3 Sessions are still working. Quit anyway?',
      buttons: ['Quit', 'Cancel'],
    });
    expect(quitConfirm('en', { working: 1, viewers: 0 })?.message).toBe(
      '1 Session is still working. Quit anyway?',
    );
  });

  it('speaks Spanish', () => {
    expect(quitConfirm('es', { working: 2, viewers: 0 })).toEqual({
      message: '2 sesiones siguen trabajando. ¿Salir de todos modos?',
      buttons: ['Salir', 'Cancelar'],
    });
    expect(quitConfirm('es', { working: 1, viewers: 0 })?.message).toBe(
      '1 sesión sigue trabajando. ¿Salir de todos modos?',
    );
  });

  it('asks nothing when no Turn runs, even with Remote devices connected', () => {
    expect(quitConfirm('en', { working: 0, viewers: 0 })).toBeNull();
    expect(quitConfirm('es', { working: 0, viewers: 2 })).toBeNull();
  });

  it('says how many Remote devices are connected to a host', () => {
    expect(quitConfirm('en', { working: 2, viewers: 1 })?.message).toBe(
      '2 Sessions are still working and 1 Remote device is connected to this Device. Quit anyway?',
    );
    expect(quitConfirm('en', { working: 1, viewers: 2 })?.message).toBe(
      '1 Session is still working and 2 Remote devices are connected to this Device. Quit anyway?',
    );
    expect(quitConfirm('es', { working: 1, viewers: 2 })?.message).toBe(
      '1 sesión sigue trabajando y 2 Dispositivos remotos están conectados a este Dispositivo. ¿Salir de todos modos?',
    );
    expect(quitConfirm('es', { working: 3, viewers: 1 })?.message).toBe(
      '3 sesiones siguen trabajando y 1 Dispositivo remoto está conectado a este Dispositivo. ¿Salir de todos modos?',
    );
  });
});
