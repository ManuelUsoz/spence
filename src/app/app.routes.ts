import type { Routes } from '@angular/router';
import { AppInfoView } from './features/app-info/app-info';
import { SessionPage } from './features/session/session-page';

export const routes: Routes = [
  { path: '', pathMatch: 'full', component: AppInfoView },
  { path: 'sessions/:id', component: SessionPage },
];
