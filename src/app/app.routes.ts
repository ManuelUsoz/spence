import type { Routes } from '@angular/router';
import { AppInfoView } from './features/app-info/app-info';

export const routes: Routes = [
  { path: '', pathMatch: 'full', component: AppInfoView },
  // PROTOTYPE (throwaway, branch prototype/calm-thread): issue #12.
  {
    path: 'prototype/thread',
    loadComponent: () =>
      import('./features/thread-prototype/thread-prototype').then((m) => m.ThreadPrototype),
  },
];
