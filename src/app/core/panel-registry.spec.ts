import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ProjectId } from '../../shared/projects/projects.rpc';
import { SessionId } from '../../shared/sessions/sessions.rpc';
import { PanelId, type WorkspacePanel } from '../../shared/tabs/tabs.rpc';
import {
  PANEL_DEFINITION,
  PanelRegistry,
  type PanelDefinition,
  type PanelRenderContext,
} from './panel-registry';

@Component({
  selector: 'app-test-session-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
class TestSessionPanel {}

@Component({
  selector: 'app-test-session-override',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
class TestSessionOverride {}

@Component({
  selector: 'app-test-notes-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
class TestNotesPanel {}

describe('PanelRegistry', () => {
  it('starts empty when no PANEL_DEFINITION providers are registered', () => {
    TestBed.configureTestingModule({});
    const registry = TestBed.inject(PanelRegistry);

    expect(registry.has('Session')).toBe(false);
    expect(registry.get('Session')).toBeUndefined();
    expect(registry.kinds()).toEqual([]);
  });

  it('registers multiple Panel definitions including custom kinds and supports overrides', () => {
    const sessionDef: PanelDefinition = {
      kind: 'Session',
      component: TestSessionPanel,
      headerMeta: (ctx, resolveSessionTitle) => {
        if (ctx.panel.spec._tag !== 'Session' || ctx.panel.spec.sessionId === undefined) {
          return { title: 'New Session', untitled: true };
        }
        const resolved = resolveSessionTitle(ctx.panel.spec.sessionId);
        return resolved === null
          ? { title: 'New Session', untitled: true }
          : { title: resolved, untitled: false };
      },
    };
    const notesDef: PanelDefinition = {
      kind: 'Notes',
      component: TestNotesPanel,
      defaultTitle: 'Scratchpad',
      headerMeta: (ctx) => ({ title: `Notes · ${ctx.projectName}` }),
    };
    const sessionOverride: PanelDefinition = {
      kind: 'Session',
      component: TestSessionOverride,
      headerMeta: sessionDef.headerMeta,
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: PANEL_DEFINITION, multi: true, useValue: sessionDef },
        { provide: PANEL_DEFINITION, multi: true, useValue: notesDef },
        { provide: PANEL_DEFINITION, multi: true, useValue: sessionOverride },
      ],
    });

    const registry = TestBed.inject(PanelRegistry);

    expect(registry.has('Session')).toBe(true);
    expect(registry.has('Notes')).toBe(true);
    expect(registry.has('Unknown')).toBe(false);
    expect(registry.kinds()).toEqual(['Session', 'Notes']);
    expect(registry.get('Session')?.component).toBe(TestSessionOverride);
    expect(registry.get('Notes')?.component).toBe(TestNotesPanel);

    const panel: WorkspacePanel = {
      id: PanelId.make('p1'),
      spec: { _tag: 'Session', sessionId: SessionId.make('s1') },
    };
    const ctx: PanelRenderContext = {
      panel,
      projectId: ProjectId.make('proj-1'),
      projectName: 'spence',
      focused: true,
    };

    expect(registry.get('Session')?.headerMeta?.(ctx, () => 'Fix tests')).toEqual({
      title: 'Fix tests',
      untitled: false,
    });
    expect(registry.get('Notes')?.headerMeta?.(ctx, () => null)).toEqual({
      title: 'Notes · spence',
    });
  });
});
