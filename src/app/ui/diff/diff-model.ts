export interface DiffLine {
  readonly kind: 'context' | 'add' | 'delete';
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly text: string;
}
export interface DiffHunk {
  readonly header: string;
  readonly lines: ReadonlyArray<DiffLine>;
}
