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

const decodeBase64Bytes = (data: string): Uint8Array | undefined => {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return undefined;
  }
};

const u16BE = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);

const u16LE = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);

const u24LE = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);

const u32BE = (bytes: Uint8Array, offset: number): number =>
  (((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)) >>>
  0;

const isSofMarker = (marker: number): boolean =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

const readImageDimensions = (
  data: string,
): { readonly width: number; readonly height: number } | undefined => {
  const bytes = decodeBase64Bytes(data);
  if (bytes === undefined || bytes.length < 10) return undefined;

  // PNG: 8-byte signature + IHDR width/height at 16..23
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { width: u32BE(bytes, 16), height: u32BE(bytes, 20) };
  }

  // GIF: 'GIF87a' / 'GIF89a' + little-endian width/height at 6..9
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { width: u16LE(bytes, 6), height: u16LE(bytes, 8) };
  }

  // WebP: 'RIFF....WEBP' + VP8 / VP8L / VP8X chunk
  if (
    bytes.length >= 30 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const chunk = String.fromCharCode(
      bytes[12] ?? 0,
      bytes[13] ?? 0,
      bytes[14] ?? 0,
      bytes[15] ?? 0,
    );
    if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { width: u16LE(bytes, 26) & 0x3fff, height: u16LE(bytes, 28) & 0x3fff };
    }
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const b0 = bytes[21] ?? 0;
      const b1 = bytes[22] ?? 0;
      const b2 = bytes[23] ?? 0;
      const b3 = bytes[24] ?? 0;
      return {
        width: 1 + (b0 | ((b1 & 0x3f) << 8)),
        height: 1 + (((b1 & 0xc0) >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)),
      };
    }
    if (chunk === 'VP8X') {
      return { width: 1 + u24LE(bytes, 24), height: 1 + u24LE(bytes, 27) };
    }
  }

  // JPEG: SOI (FF D8) followed by marker segments until SOFn
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1] ?? 0;
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const segmentLength = u16BE(bytes, offset + 2);
      if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) break;
      if (isSofMarker(marker) && offset + 8 < bytes.length) {
        return { width: u16BE(bytes, offset + 7), height: u16BE(bytes, offset + 5) };
      }
      offset += 2 + segmentLength;
    }
  }

  return undefined;
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
    const dimensions = readImageDimensions(image.data);
    if (
      dimensions !== undefined &&
      Math.max(dimensions.width, dimensions.height) > limits.maxDimensionPx
    ) {
      blocked.push({
        imageId: image.id,
        reason: `Image exceeds destination dimension limit (${limits.maxDimensionPx} px).`,
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
