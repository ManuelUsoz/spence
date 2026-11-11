import { Injectable, computed, signal } from '@angular/core';

export interface Chat {
  readonly id: number;
  readonly title: string;
}

/** The user's chats and which one is open. Local UI state for now: nothing is persisted or sent to main yet. */
@Injectable({ providedIn: 'root' })
export class ChatsState {
  private readonly _chats = signal<readonly Chat[]>([]);
  private readonly _activeId = signal<number | null>(null);
  private nextId = 1;

  readonly chats = this._chats.asReadonly();
  readonly activeId = this._activeId.asReadonly();
  readonly active = computed(
    () => this._chats().find((chat) => chat.id === this._activeId()) ?? null,
  );

  /** Starts an empty chat on top of the list and opens it. */
  start(): Chat {
    const chat: Chat = { id: this.nextId, title: $localize`Chat ${this.nextId}:number:` };
    this.nextId += 1;
    this._chats.update((chats) => [chat, ...chats]);
    this._activeId.set(chat.id);
    return chat;
  }

  open(id: number): void {
    if (this._chats().some((chat) => chat.id === id)) this._activeId.set(id);
  }

  remove(id: number): void {
    this._chats.update((chats) => chats.filter((chat) => chat.id !== id));
    if (this._activeId() === id) this._activeId.set(this._chats()[0]?.id ?? null);
  }
}
