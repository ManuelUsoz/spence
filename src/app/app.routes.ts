import type { Routes } from '@angular/router';
import { AppInfoView } from './features/app-info/app-info';
import { FontsPrototype } from './features/fonts-prototype/fonts-prototype';

export const routes: Routes = [
  { path: '', pathMatch: 'full', component: AppInfoView },
  // PROTOTYPE (throwaway, branch prototype/fonts)
  { path: 'prototype/fonts', component: FontsPrototype },
];
