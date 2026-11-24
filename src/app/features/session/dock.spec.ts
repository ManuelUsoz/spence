import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PermissionRequestId,
  StepId,
  TurnId,
  type PermissionOption,
  type Plan,
  type Step,
} from '../../../shared/sessions/sessions.rpc';
import { Dock, type DockPermission } from './dock';

const turnId = TurnId.make('turn-1');

const makeStep = (patch: Partial<Step>): Step => ({
  _tag: 'Step',
  id: StepId.make('step-1'),
  turnId,
  title: 'Run step',
  kind: 'other',
  status: 'pending',
  files: [],
  diffs: [],
  output: '',
  ...patch,
});

const options: ReadonlyArray<PermissionOption> = [
  { id: 'allow', label: 'Allow once', kind: 'allowOnce' },
  { id: 'always', label: 'Always allow', kind: 'allowAlways' },
  { id: 'reject', label: 'Reject', kind: 'rejectOnce' },
];

const makePlan = (): Plan => ({
  _tag: 'Plan',
  entries: [
    { content: 'Inspect repo', priority: 'high', status: 'completed' },
    { content: 'Run tests', priority: 'high', status: 'inProgress' },
  ],
});

const mount = (inputs: {
  permission?: DockPermission | null;
  plan?: Plan | null;
  sessionCwd?: string | null;
}): ComponentFixture<Dock> => {
  TestBed.configureTestingModule({});
  const fixture = TestBed.createComponent(Dock);
  fixture.componentRef.setInput('permission', inputs.permission ?? null);
  fixture.componentRef.setInput('plan', inputs.plan ?? null);
  fixture.componentRef.setInput('sessionCwd', inputs.sessionCwd ?? null);
  fixture.detectChanges();
  return fixture;
};

const root = (fixture: ComponentFixture<Dock>): HTMLElement => fixture.nativeElement as HTMLElement;

afterEach(() => TestBed.resetTestingModule());

describe('Dock', () => {
  it('takes priority over Plan while a Permission request is pending and restores Plan afterward', () => {
    const permission: DockPermission = {
      requestId: PermissionRequestId.make('perm-1'),
      title: 'ls -la',
      step: makeStep({ title: 'ls -la', kind: 'execute' }),
      options,
    };
    const fixture = mount({ permission, plan: makePlan(), sessionCwd: '/repo/app' });

    expect(root(fixture).querySelector('[data-testid="dock"]')).not.toBeNull();
    expect(root(fixture).querySelector('[data-plan-segment]')).toBeNull();

    fixture.componentRef.setInput('permission', null);
    fixture.detectChanges();

    expect(root(fixture).querySelector('[data-testid="dock"]')).toBeNull();
    expect(root(fixture).querySelectorAll('[data-plan-segment]')).toHaveLength(2);
    expect(root(fixture).textContent).toContain('Plan 1 of 2');
  });

  it('shows exact step.cwd or sessionCwd fallback and full command in font-mono for execute Steps', () => {
    const withStepCwd: DockPermission = {
      requestId: PermissionRequestId.make('perm-exec-1'),
      title: 'Run tests',
      step: makeStep({
        title: 'Run tests',
        kind: 'execute',
        cwd: '/repo/app/packages/core',
        input: 'npm test -- --run',
      }),
      options,
    };
    const fixture = mount({ permission: withStepCwd, sessionCwd: '/repo/app' });

    expect(root(fixture).querySelector('[data-testid="dock-title"]')?.textContent?.trim()).toBe(
      'Run tests',
    );
    const command = root(fixture).querySelector('[data-testid="dock-command"]');
    expect(command?.textContent?.trim()).toBe('npm test -- --run');
    expect(command?.className).toContain('font-mono');

    const cwd = root(fixture).querySelector('[data-testid="dock-cwd"]');
    expect(cwd?.textContent?.trim()).toBe('/repo/app/packages/core');
    expect(cwd?.className).toContain('font-mono');

    // Falls back to sessionCwd and step.title when step.cwd and step.input are absent.
    fixture.componentRef.setInput('permission', {
      requestId: PermissionRequestId.make('perm-exec-2'),
      title: 'ls -la',
      step: makeStep({ title: 'ls -la', kind: 'execute' }),
      options,
    } satisfies DockPermission);
    fixture.detectChanges();

    expect(root(fixture).querySelector('[data-testid="dock-title"]')?.textContent?.trim()).toBe(
      'ls -la',
    );
    expect(root(fixture).querySelector('[data-testid="dock-command"]')?.textContent?.trim()).toBe(
      'ls -la',
    );
    expect(root(fixture).querySelector('[data-testid="dock-cwd"]')?.textContent?.trim()).toBe(
      '/repo/app',
    );
  });

  it('shows relative file paths and a height-capped scrollable diff preview for edit Steps', () => {
    const permission: DockPermission = {
      requestId: PermissionRequestId.make('perm-edit'),
      title: 'Edit src/app.ts',
      step: makeStep({
        title: 'Edit src/app.ts',
        kind: 'edit',
        files: ['src/app.ts'],
        diffs: [{ path: 'src/app.ts', before: 'const a = 1;', after: 'const a = 2;' }],
      }),
      options,
    };
    const fixture = mount({ permission, sessionCwd: '/repo/app' });

    const files = [...root(fixture).querySelectorAll('[data-testid="dock-file"]')].map(
      (el) => el.textContent?.trim() ?? '',
    );
    expect(files).toEqual(['src/app.ts']);
    expect(root(fixture).querySelector('[data-testid="dock-file"]')?.className).toContain(
      'font-mono',
    );

    const diffContainer = root(fixture).querySelector('[data-testid="dock-diffs"]');
    expect(diffContainer).not.toBeNull();
    expect(diffContainer?.className).toContain('overflow-auto');
    expect(diffContainer?.className).toMatch(/max-h-/);
    expect(root(fixture).querySelector('app-diff-patch')).not.toBeNull();
    const lines = [...root(fixture).querySelectorAll('[data-testid="diff-line"]')].map(
      (el) => el.textContent ?? '',
    );
    expect(lines.some((line) => line.includes('const a = 1;'))).toBe(true);
    expect(lines.some((line) => line.includes('const a = 2;'))).toBe(true);
  });

  it('shows relative files and capped structured input in font-mono text-xs for delete, move, read, fetch, and other Steps', () => {
    const fixture = mount({});
    for (const kind of ['delete', 'move', 'read', 'fetch', 'other'] as const) {
      const permission: DockPermission = {
        requestId: PermissionRequestId.make(`perm-${kind}`),
        title: `${kind} action`,
        step: makeStep({
          title: `${kind} action`,
          kind,
          files: kind === 'fetch' ? [] : ['src/target.ts'],
          input: JSON.stringify({ action: kind, target: 'src/target.ts' }, null, 2),
        }),
        options,
      };
      fixture.componentRef.setInput('permission', permission);
      fixture.detectChanges();

      const files = [...root(fixture).querySelectorAll('[data-testid="dock-file"]')].map(
        (el) => el.textContent?.trim() ?? '',
      );
      expect(files).toEqual(kind === 'fetch' ? [] : ['src/target.ts']);

      const inputEl = root(fixture).querySelector('[data-testid="dock-input"]');
      expect(inputEl?.textContent).toContain(`"action": "${kind}"`);
      expect(inputEl?.className).toContain('font-mono');
      expect(inputEl?.className).toContain('text-xs');
      expect(inputEl?.className).toContain('overflow-auto');
      expect(inputEl?.className).toMatch(/max-h-/);
    }
  });

  it('renders 1-4 keyboard hints and emits answer with the chosen option id', () => {
    const permission: DockPermission = {
      requestId: PermissionRequestId.make('perm-ans'),
      title: 'Run checks',
      step: null,
      workflowSource: { role: 'Verifier', agentName: 'Claude', title: 'Run checks' },
      options,
    };
    const fixture = mount({ permission });
    const answered: string[] = [];
    fixture.componentInstance.answer.subscribe((id) => answered.push(id));

    expect(
      root(fixture).querySelector('[data-testid="workflow-permission-source"]')?.textContent,
    ).toContain('Verifier');
    const buttons = root(fixture).querySelectorAll('[data-testid="dock-option"]');
    expect(buttons).toHaveLength(3);
    expect(buttons[0]?.querySelector('kbd')?.textContent?.trim()).toBe('1');
    expect(buttons[1]?.querySelector('kbd')?.textContent?.trim()).toBe('2');
    expect(buttons[2]?.querySelector('kbd')?.textContent?.trim()).toBe('3');

    (buttons[1] as HTMLButtonElement).click();
    expect(answered).toEqual(['always']);
  });
});
