import { Schema } from 'effect';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import { ProjectId } from '../../src/shared/projects/projects.rpc';
import { SessionId } from '../../src/shared/sessions/sessions.rpc';

/** What an Agent's report is about. `mcp` and `performance` are the ones that drive tool work. */
export const FeedbackCategory = Schema.Literals([
  'bug',
  'workflow',
  'mcp',
  'ux',
  'performance',
  'suggestion',
  'other',
]).annotate({ identifier: 'FeedbackCategory' });
export type FeedbackCategory = typeof FeedbackCategory.Type;

export const FeedbackSeverity = Schema.Literals(['low', 'medium', 'high']).annotate({
  identifier: 'FeedbackSeverity',
});
export type FeedbackSeverity = typeof FeedbackSeverity.Type;

/** How slow a tool felt to the Agent that called it; the qualitative half of a speed report. */
export const FeedbackLatency = Schema.Literals(['fast', 'ok', 'slow', 'stalled']).annotate({
  identifier: 'FeedbackLatency',
});
export type FeedbackLatency = typeof FeedbackLatency.Type;

/** The loopback MCP endpoint a report came through: each one has its own tools and failure modes. */
export const FeedbackSource = Schema.Literals(['spence', 'spence-browser']).annotate({
  identifier: 'FeedbackSource',
});
export type FeedbackSource = typeof FeedbackSource.Type;

/** A report as an Agent writes it; who wrote it and from where is added when it is stored. */
export interface ReportFeedbackInput {
  readonly summary: string;
  readonly details?: string;
  readonly category: FeedbackCategory;
  readonly severity: FeedbackSeverity;
  /** The tool the report is about, by MCP name (e.g. `snapshot`). */
  readonly tool?: string;
  /** How the tool's latency felt while the Agent used it. */
  readonly latency?: FeedbackLatency;
  /** The concrete change that would have made the tool faster or cheaper in tokens. */
  readonly suggestion?: string;
}

/** What recording a report answers, before each MCP endpoint wraps it for its own transport. */
export interface FeedbackOutcome {
  readonly text: string;
  readonly isError?: boolean;
}

/** One line of `<userData>/spence/feedback.jsonl`: the report plus who wrote it, where and about what. */
export const FeedbackEntry = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  source: FeedbackSource,
  sessionId: SessionId,
  sessionTitle: Schema.String,
  projectId: ProjectId,
  projectName: Schema.String,
  agentId: AgentId,
  agentName: Schema.String,
  model: Schema.optionalKey(Schema.String),
  cwd: Schema.String,
  category: FeedbackCategory,
  severity: FeedbackSeverity,
  tool: Schema.optionalKey(Schema.String),
  latency: Schema.optionalKey(FeedbackLatency),
  summary: Schema.String,
  details: Schema.optionalKey(Schema.String),
  suggestion: Schema.optionalKey(Schema.String),
}).annotate({ identifier: 'FeedbackEntry' });
export type FeedbackEntry = typeof FeedbackEntry.Type;

/** Longest accepted text for the free-form fields, so one report cannot flood the file. */
const MAX_SUMMARY = 500;
const MAX_DETAILS = 4_000;
const MAX_TOOL = 100;
const MAX_SUGGESTION = 2_000;

const optionalText = (value: unknown, max: number): string | undefined | null => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > max ? null : trimmed;
};

/**
 * Parses a `report_feedback` argument bag the same way for every MCP endpoint, applying the documented defaults.
 * `undefined` means malformed; an empty optional field is simply left out.
 */
export const parseReportFeedback = (
  args: Readonly<Record<string, unknown>>,
): ReportFeedbackInput | undefined => {
  const summary = optionalText(args['summary'], MAX_SUMMARY);
  const details = optionalText(args['details'], MAX_DETAILS);
  const tool = optionalText(args['tool'], MAX_TOOL);
  const suggestion = optionalText(args['suggestion'], MAX_SUGGESTION);
  if (summary === undefined || summary === null) return undefined;
  if (details === null || tool === null || suggestion === null) return undefined;

  const category = args['category'] ?? 'other';
  const severity = args['severity'] ?? 'medium';
  const latency = args['latency'];
  if (
    !Schema.is(FeedbackCategory)(category) ||
    !Schema.is(FeedbackSeverity)(severity) ||
    (latency !== undefined && !Schema.is(FeedbackLatency)(latency))
  ) {
    return undefined;
  }

  return {
    summary,
    category,
    severity,
    ...(details === undefined ? {} : { details }),
    ...(tool === undefined ? {} : { tool }),
    ...(latency === undefined ? {} : { latency }),
    ...(suggestion === undefined ? {} : { suggestion }),
  };
};
