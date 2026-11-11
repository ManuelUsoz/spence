import type { Routes } from '@angular/router';
import { AppInfoView } from './features/app-info/app-info';

export const routes: Routes = [{ path: '', pathMatch: 'full', component: AppInfoView }];
