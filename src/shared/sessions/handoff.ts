import type { AgentCapabilities, ImageLimits } from '../agents/agents.rpc';
import type {
  HandoffBlockedImage,
  HandoffImage,
  HandoffSourceEndpoint,
  HandoffTokenBudget,
  SessionId,
  Step,
  TranscriptEvent,
  TurnEnded,
  TurnId,
} from './sessions.rpc';

const KNOWN_CAPACITY_MAX_TOKENS = 8000;
const PROVISIONAL_CAP_TOKENS = 4000;
const CHARS_PER_TOKEN = 4;

/** Conservative character-based token estimate for summary budget enforcement (not a Context usage counter). */
export const estimateSummaryTokens = (text: string): number =>
  text.length === 0 ? 0 : Math.ceil(text.length / CHARS_PER_TOKEN);

/**
 * Computes the Summary handoff token budget: `min(10% destination capacity, 8,000)` when capacity is known,
 * else a provisional `4,000` estimated cap.
 */
export const computeHandoffBudget = (
  text: string,
  destinationCapacity?: number,
): HandoffTokenBudget => {
  const estimatedTokens = estimateSummaryTokens(text);
  const knownCapacity =
    destinationCapacity !== undefined &&
    Number.isFinite(destinationCapacity) &&
    destinationCapacity > 0;
  const capTokens = knownCapacity
    ? Math.max(1, Math.min(Math.floor(destinationCapacity * 0.1), KNOWN_CAPACITY_MAX_TOKENS))
    : PROVISIONAL_CAP_TOKENS;
  return {
    estimatedTokens,
    capTokens,
    knownCapacity,
    ...(knownCapacity ? { destinationCapacity } : {}),
    overBudget: estimatedTokens > capTokens,
  };
};

/** Extracts all original Images from Transcript Messages so the user can select them separately. */
export const extractHandoffImages = (
  events: ReadonlyArray<TranscriptEvent>,
): ReadonlyArray<HandoffImage> => {
  const images: HandoffImage[] = [];
  for (const event of events) {
    if (event.item._tag !== 'Message') continue;
    const message = event.item;
    for (let index = 0; index < message.parts.length; index++) {
      const part = message.parts[index];
      if (part === undefined || part._tag !== 'image') continue;
      images.push({
        id: `${event.seq}:${index}`,
        mimeType: part.mimeType,
        data: part.data,
        turnId: message.turnId,
        role: message.role,
        seq: event.seq,
      });
    }
  }
  return images;
};

/** Computes the latest settled Turn endpoint (including `cancelled`) and message count for source binding. */
export const computeSourceEndpoint = (
  sessionId: SessionId,
  events: ReadonlyArray<TranscriptEvent>,
): HandoffSourceEndpoint => {
  let turnId: TurnId | undefined;
  let turnNumber = 0;
  let messageCount = 0;
  const seq = events.at(-1)?.seq ?? 0;

  for (const event of events) {
    if (event.item._tag === 'TurnEnded') {
      turnNumber += 1;
      turnId = event.item.turnId;
    } else if (event.item._tag === 'Message') {
      messageCount += 1;
    }
  }

  return {
    sessionId,
    ...(turnId === undefined ? {} : { turnId }),
    turnNumber,
    seq,
    messageCount,
  };
};

const condenseText = (text: string, maxLength = 220): string => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
};

const describeStep = (step: Step): string => {
  const outputSuffix =
    step.output !== undefined && step.output.trim().length > 0
      ? ` — ${condenseText(step.output, 120)}`
      : '';
  return `${step.title} (${step.status})${outputSuffix}`;
};

const isDecisionLine = (text: string): boolean =>
  /\b(decided|decision|constraint|must|never|always|choose|chosen|using|use)\b/i.test(text);

const isVerificationStep = (step: Step): boolean =>
  step.kind === 'execute' && /\b(test|verify|lint|typecheck|build|spec|check)\b/i.test(step.title);

/**
 * Deterministically builds a structured Transcript extract for Summary handoff review:
 * goal, decisions/constraints, relevant files, completed and outstanding work, verification results,
 * relevant Images described, private `Thought`s excluded, and tool outputs condensed.
 */
export const buildStructuredTranscriptExtract = (
  events: ReadonlyArray<TranscriptEvent>,
): string => {
  const userGoals: string[] = [];
  const decisions: string[] = [];
  const files = new Set<string>();
  const completedWork: string[] = [];
  const outstandingWork: string[] = [];
  const verifications: string[] = [];
  const imageNotes: string[] = [];
  const outcomes = new Map<TurnId, TurnEnded['outcome']>();
  const latestTurnMessages = new Map<TurnId, string[]>();

  for (const event of events) {
    if (event.item._tag === 'TurnEnded') {
      outcomes.set(event.item.turnId, event.item.outcome);
    }
  }

  for (const event of events) {
    const item = event.item;
    if (item._tag === 'Thought' || item._tag === 'ThoughtDelta') {
      // Private Thoughts are strictly excluded from Summary handoffs.
      continue;
    }
    if (item._tag === 'Message') {
      const textParts = item.parts
        .filter((part) => part._tag === 'text')
        .map((part) => part.text.trim())
        .filter((text) => text.length > 0);
      const joined = textParts.join(' ').trim();
      const imageCount = item.parts.filter((part) => part._tag === 'image').length;
      if (imageCount > 0) {
        imageNotes.push(
          `${imageCount} ${item.role} image(s) attached in Turn ${item.turnId} (available for separate selection)`,
        );
      }
      if (joined.length === 0) continue;
      if (item.role === 'user') {
        userGoals.push(condenseText(joined, 240));
      } else {
        const list = latestTurnMessages.get(item.turnId) ?? [];
        list.push(condenseText(joined, 220));
        latestTurnMessages.set(item.turnId, list);
        if (isDecisionLine(joined)) {
          decisions.push(condenseText(joined, 200));
        }
      }
      const outcome = outcomes.get(item.turnId);
      if (item.role === 'agent') {
        if (outcome?._tag === 'done') {
          completedWork.push(condenseText(joined, 200));
        } else if (outcome !== undefined) {
          outstandingWork.push(
            `Turn ${item.turnId} (${outcome._tag}): ${condenseText(joined, 180)}`,
          );
        }
      } else if (outcome !== undefined && outcome._tag !== 'done') {
        outstandingWork.push(`Unfinished request (${outcome._tag}): ${condenseText(joined, 180)}`);
      }
      continue;
    }
    if (item._tag === 'Step') {
      for (const file of item.files) {
        if (file.trim().length > 0) files.add(file.trim());
      }
      for (const diff of item.diffs) {
        if (diff.path.trim().length > 0) files.add(diff.path.trim());
      }
      if (isVerificationStep(item)) {
        verifications.push(describeStep(item));
      } else if (item.status === 'done') {
        completedWork.push(describeStep(item));
      } else if (
        item.status === 'failed' ||
        item.status === 'running' ||
        item.status === 'pending'
      ) {
        outstandingWork.push(describeStep(item));
      }
    }
  }

  const lines: string[] = [
    `Goal: ${userGoals.length > 0 ? userGoals.slice(0, 3).join(' | ') : 'None recorded in Transcript.'}`,
    `Decisions & constraints: ${decisions.length > 0 ? decisions.slice(-4).join('; ') : 'None explicitly stated.'}`,
    `Relevant files: ${files.size > 0 ? [...files].slice(0, 12).join(', ') : 'None recorded.'}`,
    `Completed work: ${completedWork.length > 0 ? completedWork.slice(-5).join('; ') : 'None recorded.'}`,
    `Outstanding / interrupted work: ${outstandingWork.length > 0 ? outstandingWork.slice(-4).join('; ') : 'None.'}`,
    `Verification results: ${verifications.length > 0 ? verifications.slice(-4).join('; ') : 'No verification runs recorded.'}`,
    `Images referenced: ${imageNotes.length > 0 ? imageNotes.join('; ') : 'None.'}`,
    'Missing information: Review and add any local context or uncommitted notes before confirming.',
  ];
  return lines.join('\n');
};

/** Prompt sent to an isolated tool-free ACP session when `supportsIsolatedSummary` is true. */
export const buildIsolatedSummaryPrompt = (transcriptExtract: string): string =>
  [
    'Summarize the following Session Transcript extract for a clean Summary handoff to another Agent.',
    'Do not call any tools, do not read or edit files, and do not run commands.',
    'Include only: Goal, Decisions & constraints, Relevant files, Completed work, Outstanding work, Verification results, Images referenced, and Missing information.',
    '',
    transcriptExtract,
  ].join('\n');

/** Prompt sent to the destination Agent to acknowledge the handoff without taking any actions. */
export const buildHandoffAcknowledgementPrompt = (
  summary: string,
  selectedImages: ReadonlyArray<HandoffImage>,
): string => {
  const imageNote =
    selectedImages.length > 0
      ? `\n\n[${selectedImages.length} selected image(s) attached for context.]`
      : '';
  return [
    'You are receiving a reviewed Summary handoff from a previous Agent context.',
    'Acknowledge that you have received this handoff context and wait for the user’s next instruction.',
    'Do NOT run any tools, commands, file reads, or edits right now.',
    '',
    summary,
    imageNote,
  ]
    .join('\n')
    .trim();
};

/** Checks which Images are incompatible with the destination Agent's capabilities and limits. */
export const checkImageCompatibility = (
  images: ReadonlyArray<HandoffImage>,
  capabilities: AgentCapabilities,
  limits: ImageLimits,
  selectedIds?: ReadonlyArray<string>,
): ReadonlyArray<HandoffBlockedImage> => {
  const blocked: HandoffBlockedImage[] = [];
  const selectedSet = selectedIds === undefined ? undefined : new Set(selectedIds);
  let selectedCount = 0;

  for (const image of images) {
    const isSelected = selectedSet === undefined || selectedSet.has(image.id);
    if (!capabilities.images) {
      blocked.push({ imageId: image.id, reason: 'Destination Agent does not accept Images.' });
      continue;
    }
    if (image.data.length > limits.maxBase64Bytes) {
      blocked.push({
        imageId: image.id,
        reason: `Image exceeds destination limit (${limits.maxBase64Bytes} base64 bytes).`,
      });
      continue;
    }
    if (isSelected) {
      selectedCount += 1;
      if (selectedCount > limits.maxPerMessage) {
        blocked.push({
          imageId: image.id,
          reason: `Exceeds destination limit of ${limits.maxPerMessage} Image(s) per Message.`,
        });
      }
    }
  }
  return blocked;
};
