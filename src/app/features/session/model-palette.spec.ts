import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { describe, expect, it } from 'vitest';
import type { Effort, Model } from '../../../shared/agents/agents.rpc';
import {
  ModelPalette,
  parseModelPaletteQuery,
  type EffortOptionState,
  type ModelOptionState,
  type PaletteAgent,
} from './model-palette';

@Component({
  imports: [ModelPalette],
  template: `
    <app-model-palette
      [activeAgentId]="activeAgentId()"
      [agentName]="agentName()"
      [menuAgents]="menuAgents()"
      [canSwitchAgent]="canSwitchAgent()"
      [isDraft]="isDraft()"
      [modelsSupported]="modelsSupported()"
      [effortSupported]="effortSupported()"
      [modelChangePreservesContext]="modelChangePreservesContext()"
      [modelsLimitation]="modelsLimitation()"
      [model]="model()"
      [effort]="effort()"
      [controlsDisabled]="controlsDisabled()"
      [preferUpward]="preferUpward()"
      pickerLabel="Agent, model and effort"
      (agentSelect)="agentSelects.push($event)"
      (modelSelect)="modelSelects.push($event)"
      (effortSelect)="effortSelects.push($event)"
    />
  `,
})
class HostComponent {
  readonly activeAgentId = signal('claude');
  readonly agentName = signal('Claude');
  readonly menuAgents = signal<ReadonlyArray<PaletteAgent>>([
    { id: 'claude', name: 'Claude', crossDeviceTools: true },
    { id: 'codex', name: 'Codex', crossDeviceTools: true },
  ]);
  readonly canSwitchAgent = signal(true);
  readonly isDraft = signal(true);
  readonly modelsSupported = signal(true);
  readonly effortSupported = signal(true);
  readonly modelChangePreservesContext = signal(true);
  readonly modelsLimitation = signal<string | null>(null);
  readonly model = signal<ModelOptionState | undefined>({
    value: 'opus',
    choices: [
      { id: 'opus', name: 'Opus 4.6', description: 'Deepest reasoning' } satisfies Model,
      { id: 'sonnet', name: 'Sonnet 4.6', description: 'Fast everyday coding' } satisfies Model,
      { id: 'haiku', name: 'Haiku 4.5' } satisfies Model,
    ],
  });
  readonly effort = signal<EffortOptionState | undefined>({
    value: 'high',
    choices: ['low', 'medium', 'high', 'max'],
  });
  readonly controlsDisabled = signal(false);
  readonly preferUpward = signal(true);

  readonly agentSelects: Array<string> = [];
  readonly modelSelects: Array<string> = [];
  readonly effortSelects: Array<Effort> = [];
}

describe('parseModelPaletteQuery', () => {
  it('extracts effort keywords and preserves model filter terms', () => {
    expect(parseModelPaletteQuery('sonnet max')).toEqual({
      terms: ['sonnet'],
      effort: 'max',
    });
    expect(parseModelPaletteQuery('gpt @med codex')).toEqual({
      terms: ['gpt', 'codex'],
      effort: 'medium',
    });
    expect(parseModelPaletteQuery('low')).toEqual({
      terms: [],
      effort: 'low',
    });
    expect(parseModelPaletteQuery('opus 4.6')).toEqual({
      terms: ['opus', '4.6'],
      effort: null,
    });
  });
});

describe('ModelPalette', () => {
  const mount = () => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return fixture;
  };

  const query = <T extends Element>(fixture: ReturnType<typeof mount>, testId: string): T | null =>
    (fixture.nativeElement as HTMLElement).querySelector<T>(`[data-testid="${testId}"]`);

  it('filters models and applies model + parsed effort in one Enter press', () => {
    const fixture = mount();
    query<HTMLButtonElement>(fixture, 'model-picker')?.click();
    fixture.detectChanges();

    const search = query<HTMLInputElement>(fixture, 'model-palette-search');
    expect(search).not.toBeNull();
    if (search === null) return;

    search.value = 'sonnet max';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(query(fixture, 'model-option-opus')).toBeNull();
    expect(query(fixture, 'model-option-sonnet')).not.toBeNull();

    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    expect(fixture.componentInstance.effortSelects).toEqual(['max']);
    expect(fixture.componentInstance.modelSelects).toEqual(['sonnet']);
    expect(query(fixture, 'agent-menu')).toBeNull();
  });

  it('does not apply parsed effort when model switch requires an active-session handoff', () => {
    const fixture = mount();
    fixture.componentInstance.isDraft.set(false);
    fixture.componentInstance.modelChangePreservesContext.set(false);
    fixture.detectChanges();

    query<HTMLButtonElement>(fixture, 'model-picker')?.click();
    fixture.detectChanges();

    const search = query<HTMLInputElement>(fixture, 'model-palette-search');
    expect(search).not.toBeNull();
    if (search === null) return;

    search.value = 'sonnet low';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    expect(fixture.componentInstance.effortSelects).toEqual([]);
    expect(fixture.componentInstance.modelSelects).toEqual(['sonnet']);
  });

  it('steps offered effort levels with ArrowLeft/ArrowRight when search is empty and closes on Escape', () => {
    const fixture = mount();
    fixture.componentInstance.effort.set({ value: 'medium', choices: ['low', 'medium', 'high'] });
    fixture.detectChanges();

    const trigger = query<HTMLButtonElement>(fixture, 'model-picker');
    trigger?.click();
    fixture.detectChanges();

    const search = query<HTMLInputElement>(fixture, 'model-palette-search');
    expect(search).not.toBeNull();
    if (search === null) return;

    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.effortSelects).toEqual(['high']);

    // Wraps cleanly among offered choices without touching unoffered `max`.
    fixture.componentInstance.effort.set({ value: 'high', choices: ['low', 'medium', 'high'] });
    fixture.detectChanges();
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.effortSelects).toEqual(['high', 'low']);

    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(query(fixture, 'agent-menu')).toBeNull();
  });

  it('shows inline 4-bar effort meter on the single active/highlighted row and deduplicates pointerdown+click', () => {
    const fixture = mount();
    query<HTMLButtonElement>(fixture, 'model-picker')?.click();
    fixture.detectChanges();

    const paletteEl = fixture.debugElement.query(By.directive(ModelPalette));
    expect(paletteEl).not.toBeNull();

    const lowBar = query<HTMLButtonElement>(fixture, 'effort-low');
    expect(lowBar).not.toBeNull();
    lowBar?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    lowBar?.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.effortSelects).toEqual(['low']);
  });

  it('places the palette upward or downward based on preferUpward and available space', () => {
    const fixture = mount();
    query<HTMLButtonElement>(fixture, 'model-picker')?.click();
    fixture.detectChanges();
    expect(query(fixture, 'agent-menu')?.getAttribute('data-placement')).toBe('up');
    expect(query(fixture, 'agent-menu')?.classList.contains('bottom-full')).toBe(true);

    query<HTMLButtonElement>(fixture, 'model-picker')?.click();
    fixture.componentInstance.preferUpward.set(false);
    fixture.detectChanges();
    query<HTMLButtonElement>(fixture, 'model-picker')?.click();
    fixture.detectChanges();
    expect(query(fixture, 'agent-menu')?.getAttribute('data-placement')).toBe('down');
    expect(query(fixture, 'agent-menu')?.classList.contains('top-full')).toBe(true);
  });
});
