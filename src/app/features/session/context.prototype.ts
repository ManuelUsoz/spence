// Throwaway: hoverable context ring and Composer command palette, with simulated state only.
import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  isDevMode,
  signal,
} from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { HlmTextareaImports } from '@ui/textarea';
import { HlmNativeSelectImports } from '@ui/native-select';
import { HlmTooltipImports } from '@ui/tooltip';
import { HlmInputImports } from '@ui/input';

type Reading = 'reported' | 'count' | 'unavailable' | 'historical' | 'waiting' | 'over';
type Operation = 'Compact' | 'Clear' | 'Switch Agent' | 'Fork';

@Component({
  selector: 'app-root',
  imports: [
    HlmButtonImports,
    HlmTextareaImports,
    HlmNativeSelectImports,
    HlmTooltipImports,
    HlmInputImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './context.prototype.html',
})
export class ContextPrototype {
  protected readonly development = isDevMode();
  protected readonly reading = signal<Reading>('reported');
  protected readonly running = signal(false);
  protected readonly supported = signal(true);
  protected readonly palette = signal(false);
  protected readonly query = signal('');
  protected readonly selected = signal(0);
  protected readonly commands: ReadonlyArray<{ name: Operation; description: string }> = [
    { name: 'Compact', description: 'Make room in the current Agent memory' },
    { name: 'Clear', description: 'Start fresh memory; keep the Transcript' },
    { name: 'Switch Agent', description: 'Continue this Session with another Agent' },
    { name: 'Fork', description: 'Start a linked Session with an Agent and Model' },
  ];
  protected readonly filtered = computed(() =>
    this.commands.filter((command) =>
      `${command.name} ${command.description}`.toLowerCase().includes(this.query().toLowerCase()),
    ),
  );
  protected readonly measured = computed(
    () => this.reading() === 'reported' || this.reading() === 'over',
  );
  protected readonly ringOffset = computed(() => (this.reading() === 'over' ? 0 : 88));
  protected readonly tooltip = computed(() => {
    const state = this.reading();
    const exact =
      state === 'unavailable'
        ? 'No report for this Agent context and Model.'
        : state === 'count'
          ? 'Exact count: 24,000 tokens. Capacity not reported.'
          : state === 'over'
            ? 'Exact values: 210,000 / 200,000 tokens.'
            : 'Exact values: 24,000 / 200,000 tokens.';
    return `Context: ${this.label()}. ${exact} Reported by ${this.agent()}. ${
      state === 'historical' || state === 'waiting'
        ? 'Historical reading; waiting for a new report.'
        : 'Latest report; not a live counter.'
    }`;
  });
  protected readonly operation = signal<Operation | null>(null);
  protected readonly agent = signal('Claude');
  protected readonly destination = signal('Codex');
  protected readonly model = signal('Default model (fixture)');
  protected readonly summary = signal(
    'Goal: make context management understandable.\nDecisions: preserve the Transcript; use Agent-reported context readings only.\nCompleted: reviewed the Composer and handoff boundaries.\nNext: compare context control placements.\nVerification: no production changes made.\nMissing information: provider-specific capability evidence.',
  );
  protected readonly markers = signal<string[]>([]);
  protected readonly phase = signal<'review' | 'starting' | 'failed' | 'success'>('review');
  protected readonly message = signal('');
  protected readonly label = computed(() => {
    switch (this.reading()) {
      case 'reported':
        return '24.00k / 200.00k · 12.00%';
      case 'count':
        return '24.00k · capacity unknown';
      case 'unavailable':
        return 'Context usage unavailable';
      case 'historical':
        return 'Historical · 24.00k / 200.00k · 12.00%';
      case 'waiting':
        return 'Awaiting context report';
      case 'over':
        return '210.00k / 200.00k · 105.00%';
    }
  });

  protected togglePalette(): void {
    this.palette.update((open) => !open);
    this.query.set('');
    this.selected.set(0);
    if (this.palette())
      setTimeout(() => document.getElementById('context-command-search')?.focus());
  }

  protected chooseSelected(): void {
    const command = this.filtered()[this.selected()];
    if (command) this.begin(command.name);
  }

  @HostListener('document:keydown', ['$event'])
  protected key(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      this.togglePalette();
      return;
    }
    if (event.key === 'Escape' && this.palette()) {
      this.palette.set(false);
      document.getElementById('context-command-trigger')?.focus();
    }
    if (this.palette() && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      this.selected.update(
        (index) =>
          (index + (event.key === 'ArrowDown' ? 1 : -1) + this.filtered().length) %
          Math.max(1, this.filtered().length),
      );
    }
  }

  protected scenario(value: string): void {
    switch (value) {
      case 'reported':
      case 'count':
      case 'unavailable':
      case 'historical':
      case 'waiting':
      case 'over':
        this.reading.set(value);
    }
  }

  protected begin(operation: Operation): void {
    if (this.running() || (operation === 'Compact' && !this.supported())) return;
    this.palette.set(false);
    this.operation.set(operation);
    this.phase.set('review');
    this.message.set('');
  }

  protected continue(): void {
    const operation = this.operation();
    if (operation === 'Switch Agent' || operation === 'Fork') {
      this.phase.set('starting');
      return;
    }
    if (operation === 'Compact') this.compact();
    if (operation === 'Clear') {
      this.reading.set('unavailable');
      this.markers.update((items) => [
        ...items,
        'Memory cleared · earlier Messages remain in the Transcript',
      ]);
    }
    this.operation.set(null);
  }

  protected compact(): void {
    this.markers.update((items) => [
      ...items,
      'Context compacted · previous reading is historical',
    ]);
    this.reading.set('waiting');
  }

  protected acknowledge(): void {
    const operation = this.operation();
    if (operation === 'Switch Agent') this.agent.set(this.destination());
    this.markers.update((items) => [
      ...items,
      operation === 'Fork'
        ? `Fork created with ${this.destination()} · source unchanged · shared Project folder`
        : `Switched to ${this.destination()} · approved summary · earlier Messages are not replayed`,
    ]);
    if (operation === 'Switch Agent') this.reading.set('unavailable');
    this.phase.set('success');
    this.message.set(
      operation === 'Fork'
        ? 'New Session acknowledged and waiting. Its context usage is unavailable. Source remains selected.'
        : 'Destination acknowledged. Waiting for your next instruction.',
    );
  }
}
