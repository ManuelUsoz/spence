import type { Routes } from '@angular/router';
import { AppInfoView } from './features/app-info/app-info';

export const routes: Routes = [
  { path: '', pathMatch: 'full', component: AppInfoView },
  // PROTOTYPE (throwaway, branch prototype/project-sidebar): issue #19.
  {
    path: 'prototype/sidebar',
    loadComponent: () =>
      import('./features/sidebar-prototype/sidebar-prototype').then((m) => m.SidebarPrototype),
  },
];
