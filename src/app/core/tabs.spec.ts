import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ProjectId } from '../../shared/projects/projects.rpc';
import { SessionId } from '../../shared/sessions/sessions.rpc';
import { Tabs } from './tabs';

const app = ProjectId.make('app');
const api = ProjectId.make('api');
const fixBuild = { id: SessionId.make('s1'), projectId: app, title: 'Fix the build' };
const addLogin = { id: SessionId.make('s2'), projectId: api, title: 'Add login' };

const tabs = (): Tabs => TestBed.inject(Tabs);

describe('Tabs', () => {
  it('opens a Session in one Tab and activates it; opening it again reuses that Tab', () => {
    const state = tabs();
    state.open(fixBuild);
    state.open(addLogin);
    expect(state.tabs().map((tab) => tab.title)).toEqual(['Fix the build', 'Add login']);
    expect(state.active()?.title).toBe('Add login');

    state.open(fixBuild);
    expect(state.tabs()).toHaveLength(2);
    expect(state.active()?.title).toBe('Fix the build');
  });

  it('starts a draft per Project, reusing that Project draft when there is one', () => {
    const state = tabs();
    const draft = state.startDraft(app);
    expect(draft.session).toBeNull();
    expect(state.active()).toBe(draft);
    expect(state.draftOf(app)).toBe(draft);
    expect(state.draftOf(api)).toBeNull();

    state.open(fixBuild);
    expect(state.startDraft(app)).toBe(draft);
    expect(state.active()).toBe(draft);
    expect(state.tabs()).toHaveLength(2);
  });

  it('closes a Tab and activates its neighbour; closing a draft forgets it', () => {
    const state = tabs();
    const draft = state.startDraft(app);
    state.open(fixBuild);
    state.open(addLogin);
    state.activate(state.tabs()[1]?.id ?? '');
    expect(state.active()?.title).toBe('Fix the build');

    state.close(state.tabs()[1]?.id ?? '');
    expect(state.tabs().map((tab) => tab.session)).toEqual([null, addLogin.id]);
    expect(state.active()?.title).toBe('Add login');

    state.close(draft.id);
    expect(state.draftOf(app)).toBeNull();
    state.close(state.tabs()[0]?.id ?? '');
    expect(state.active()).toBeNull();
  });

  it('knows which Sessions are open', () => {
    const state = tabs();
    state.open(fixBuild);
    expect(state.isOpen(fixBuild.id)).toBe(true);
    expect(state.isOpen(addLogin.id)).toBe(false);
  });
});
