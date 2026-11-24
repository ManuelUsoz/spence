import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { StepId, TurnId, type Step } from '../../../shared/sessions/sessions.rpc';
import { Ticker } from './ticker';
import type { TurnWork } from './thread';

const turn1 = TurnId.make('turn-1');
const turn2 = TurnId.make('turn-2');

const makeStep = (patch?: Partial<Step>): Step => ({
  _tag: 'Step',
  id: StepId.make('step-1'),
  turnId: turn1,
  title: 'npm test',
  kind: 'execute',
  status: 'running',
  files: [],
  diffs: [],
  output: '',
  startedAt: 1_000,
  ...patch,
});

const makeWork = (patch?: Partial<TurnWork>): TurnWork => ({
  startedAt: 1_000,
  endedAt: null,
  steps: [makeStep()],
  thought: '',
  thoughtMs: 0,
  thinkingSince: null,
  activity: 'step',
  plan: null,
  ...patch,
});

const mountTicker = (
  work: TurnWork,
  now: number,
  turnId: TurnId = turn1,
): ComponentFixture<Ticker> => {
  const fixture = TestBed.createComponent(Ticker);
  fixture.componentRef.setInput('work', work);
  fixture.componentRef.setInput('now', now);
  fixture.componentRef.setInput('turnId', turnId);
  fixture.detectChanges();
  return fixture;
};

describe('Ticker', () => {
  it('ticks an active Step elapsed duration in real time as now advances', () => {
    const fixture = mountTicker(makeWork(), 2_500);
    const root = fixture.nativeElement as HTMLElement;
    root.querySelector<HTMLButtonElement>('[data-testid="ticker-toggle"]')?.click();
    fixture.detectChanges();

    const duration = () =>
      root.querySelector('[data-testid="ticker-step-duration"]')?.textContent?.trim();
    expect(duration()).toBe('1.5s');

    fixture.componentRef.setInput('now', 13_000);
    fixture.detectChanges();
    expect(duration()).toBe('12s');
  });

  it('auto-collapses when the Turn ends or switches to a new Turn', () => {
    const work = makeWork({
      steps: [
        makeStep({
          kind: 'edit',
          files: ['src/a.ts'],
          diffs: [{ path: 'src/a.ts', before: 'old', after: 'new' }],
        }),
      ],
    });
    const fixture = mountTicker(work, 2_000, turn1);
    const root = fixture.nativeElement as HTMLElement;
    const toggle = () => root.querySelector<HTMLButtonElement>('[data-testid="ticker-toggle"]');

    toggle()?.click();
    fixture.detectChanges();
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelector('[data-testid="ticker-drawer"]')).not.toBeNull();

    root.querySelector<HTMLButtonElement>('[data-testid="ticker-touched-file"]')?.click();
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="ticker-file-diff"]')).not.toBeNull();

    // Settling the Turn collapses expanded state.
    fixture.componentRef.setInput('work', { ...work, endedAt: 3_000 });
    fixture.detectChanges();
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('[data-testid="ticker-drawer"]')).toBeNull();

    // Re-expand on a new running Turn, then switch turnId -> auto-collapses.
    const nextWork = makeWork({ startedAt: 4_000 });
    fixture.componentRef.setInput('work', nextWork);
    fixture.componentRef.setInput('turnId', turn2);
    fixture.detectChanges();
    toggle()?.click();
    fixture.detectChanges();
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');

    fixture.componentRef.setInput('work', makeWork({ startedAt: 5_000 }));
    fixture.componentRef.setInput('turnId', TurnId.make('turn-3'));
    fixture.detectChanges();
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('[data-testid="ticker-drawer"]')).toBeNull();
  });

  it('renders shared StepDetails (cwd, input, output, outputTruncated, exitCode, and inline diffs) inside the expanded Ticker', () => {
    const work = makeWork({
      steps: [
        makeStep({
          id: StepId.make('exec-1'),
          kind: 'execute',
          title: 'npm test',
          cwd: '/repo/app',
          input: 'npm test -- --run',
          output: '',
          outputTruncated: true,
          exitCode: 1,
        }),
        makeStep({
          id: StepId.make('edit-1'),
          kind: 'edit',
          title: 'Edit src/a.ts',
          status: 'done',
          files: ['src/a.ts'],
          diffs: [{ path: 'src/a.ts', before: 'old', after: 'new' }],
        }),
      ],
    });
    const fixture = mountTicker(work, 2_000);
    const root = fixture.nativeElement as HTMLElement;
    root.querySelector<HTMLButtonElement>('[data-testid="ticker-toggle"]')?.click();
    fixture.detectChanges();

    const stepButtons = [
      ...root.querySelectorAll<HTMLButtonElement>('[data-testid="ticker-step"]'),
    ];
    expect(stepButtons).toHaveLength(2);
    stepButtons[0]?.click();
    stepButtons[1]?.click();
    fixture.detectChanges();

    expect(root.querySelector('[data-testid="ticker-step-cwd"]')?.textContent?.trim()).toBe(
      '/repo/app',
    );
    expect(root.querySelector('[data-testid="ticker-step-input"]')?.textContent).toContain(
      'npm test -- --run',
    );
    expect(root.querySelector('[data-testid="ticker-step-truncated"]')?.textContent).toContain(
      'Showing the last 32 KB.',
    );
    expect(root.querySelector('[data-testid="ticker-step-exit-code"]')?.textContent).toContain('1');
    expect(
      root.querySelector('[data-testid="ticker-step-diff"] app-diff-patch')?.textContent,
    ).toContain('new');
  });
});
