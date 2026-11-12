import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { buildLaunch } from './launch';

const cmd = 'C:\\Windows\\system32\\cmd.exe';

describe('buildLaunch', () => {
  it.effect('runs an .exe directly with its arguments', () =>
    Effect.gen(function* () {
      const launch = yield* buildLaunch('C:\\bin\\agent.exe', ['--acp'], 'win32', cmd);
      expect(launch).toEqual({
        command: 'C:\\bin\\agent.exe',
        args: ['--acp'],
        windowsVerbatimArguments: false,
      });
    }),
  );

  it.effect('runs a .cmd shim through cmd.exe with one verbatim, quoted command line', () =>
    Effect.gen(function* () {
      const launch = yield* buildLaunch(
        'C:\\Program Files (x86)\\nodejs\\agent.cmd',
        ['--acp', 'mode=fast'],
        'win32',
        cmd,
      );
      expect(launch).toEqual({
        command: cmd,
        args: ['/d', '/s', '/c', '""C:\\Program Files (x86)\\nodejs\\agent.cmd" --acp mode=fast"'],
        windowsVerbatimArguments: true,
      });
    }),
  );

  it.effect('accepts a scoped npm package name as a constant argument', () =>
    Effect.gen(function* () {
      const launch = yield* buildLaunch(
        'C:\\Program Files\\nodejs\\npm.cmd',
        ['install', '-g', '@agentclientprotocol/claude-agent-acp'],
        'win32',
        cmd,
      );
      expect(launch.args).toEqual([
        '/d',
        '/s',
        '/c',
        '""C:\\Program Files\\nodejs\\npm.cmd" install -g @agentclientprotocol/claude-agent-acp"',
      ]);
    }),
  );

  it.effect('treats .BAT like .cmd, whatever the case', () =>
    Effect.gen(function* () {
      const launch = yield* buildLaunch('C:\\bin\\AGENT.BAT', [], 'win32', cmd);
      expect(launch.command).toBe(cmd);
      expect(launch.args).toEqual(['/d', '/s', '/c', '""C:\\bin\\AGENT.BAT""']);
    }),
  );

  it.effect('runs a plain binary directly on POSIX', () =>
    Effect.gen(function* () {
      const launch = yield* buildLaunch('/usr/local/bin/agent', ['acp'], 'linux', cmd);
      expect(launch).toEqual({
        command: '/usr/local/bin/agent',
        args: ['acp'],
        windowsVerbatimArguments: false,
      });
    }),
  );

  const unsafeArgs = [
    'a b',
    'x&calc',
    '"q"',
    '%PATH%',
    'a|b',
    '<in',
    'out>',
    '^',
    '!x!',
    '(x)',
    'a\nb',
    '',
  ];
  for (const arg of unsafeArgs) {
    it.effect(`rejects the non-constant argument ${JSON.stringify(arg)}`, () =>
      Effect.gen(function* () {
        const error = yield* buildLaunch('C:\\bin\\agent.cmd', [arg], 'win32', cmd).pipe(
          Effect.flip,
        );
        expect(error.reason).toBe('UnsafeArgument');
      }),
    );
  }

  it.effect('rejects unsafe arguments for an .exe too', () =>
    Effect.gen(function* () {
      const error = yield* buildLaunch('C:\\bin\\agent.exe', ['a&b'], 'win32', cmd).pipe(
        Effect.flip,
      );
      expect(error.reason).toBe('UnsafeArgument');
    }),
  );

  for (const path of [
    'C:\\100%\\agent.cmd',
    'C:\\a"b\\agent.cmd',
    'C:\\x!y\\agent.cmd',
    'C:\\a^b\\agent.cmd',
  ]) {
    it.effect(`rejects a shim path cmd.exe would reinterpret: ${path}`, () =>
      Effect.gen(function* () {
        const error = yield* buildLaunch(path, [], 'win32', cmd).pipe(Effect.flip);
        expect(error.reason).toBe('UnsafePath');
      }),
    );
  }

  it.effect('rejects a relative path', () =>
    Effect.gen(function* () {
      const error = yield* buildLaunch('agent.cmd', [], 'win32', cmd).pipe(Effect.flip);
      expect(error.reason).toBe('UnsafePath');
    }),
  );
});
