import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { AppInfoRpcs } from '../../shared/app-info/app-info.rpc';
import { DesktopApi } from './desktop-api';
import { makeDesktopTestLayer } from './desktop-layers';

const info = {
  name: 'spence',
  version: '0.1.0',
  electron: '1',
  chrome: '2',
  node: '3',
  platform: 'test',
  cwd: '/',
};

const handlers = AppInfoRpcs.toLayer({ 'AppInfo.get': () => Effect.succeed(info) });

describe('DesktopApi', () => {
  it.effect('serves AppInfo through the real contract', () =>
    Effect.gen(function* () {
      const api = yield* DesktopApi;
      expect(yield* api['AppInfo.get']()).toEqual(info);
    }).pipe(Effect.provide(makeDesktopTestLayer(handlers))),
  );
});
