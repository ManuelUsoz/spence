// Throwaway development entry point; never selected by the production build.
import { bootstrapApplication } from '@angular/platform-browser';
import { ContextPrototype } from './app/features/session/context.prototype';

bootstrapApplication(ContextPrototype).catch((error: unknown) => console.error(error));
