import { describe, expect, it } from 'vitest';
import { trayCopy } from './tray';

describe('trayCopy', () => {
  it('opens, says how many Remote devices it serves, and quits, in English', () => {
    expect(trayCopy('en', 2)).toEqual({
      open: 'Open Spence',
      status: 'Serving 2 Remote devices',
      quit: 'Quit',
    });
    expect(trayCopy('en', 1).status).toBe('Serving 1 Remote device');
    expect(trayCopy('en', 0).status).toBe('Serving 0 Remote devices');
  });

  it('speaks Spanish', () => {
    expect(trayCopy('es', 3)).toEqual({
      open: 'Abrir Spence',
      status: 'Sirviendo a 3 Dispositivos remotos',
      quit: 'Salir',
    });
    expect(trayCopy('es', 1).status).toBe('Sirviendo a 1 Dispositivo remoto');
  });
});
