import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { SessionId } from '../../../shared/sessions/sessions.rpc';
import { SessionView } from './session-view';

/** The route `sessions/:id`: the Session view for that id, rebuilt when the id changes. */
@Component({
  selector: 'app-session-page',
  imports: [SessionView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    @for (id of ids(); track id) {
      <app-session-view class="flex-1" [sessionId]="id" />
    }
  `,
})
export class SessionPage {
  private readonly params = toSignal(inject(ActivatedRoute).paramMap);

  protected readonly ids = computed(() => {
    const id = this.params()?.get('id') ?? null;
    return id === null ? [] : [SessionId.make(id)];
  });
}
