import type { ImageLimits } from '../../../shared/agents/agents.rpc';
import type { ImagePart } from '../../../shared/sessions/sessions.rpc';

/** The only Image types the Composer takes (spec 5.3). */
export const IMAGE_TYPES: ReadonlyArray<string> = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

/** An Image attached in the Composer: what goes to the Agent, plus the file name for messages. */
export interface Attached {
  readonly name: string;
  readonly mimeType: string;
  /** base64. */
  readonly data: string;
}

/** A file offered to the Composer: `size` is null when the file is not an image Spence can read. */
export interface Candidate extends Attached {
  readonly size: { readonly width: number; readonly height: number } | null;
}

/** Why an offered file was not attached. */
export type Refusal =
  | { readonly kind: 'notImage' }
  | { readonly kind: 'cantTake' }
  | { readonly kind: 'tooLarge'; readonly name: string; readonly maxBase64Bytes: number }
  | { readonly kind: 'tooWide'; readonly name: string; readonly maxDimensionPx: number }
  | { readonly kind: 'tooMany'; readonly maxPerMessage: number };

/** What the Agent takes: its limits once known (null before its live state arrives), and whether it takes Images. */
export interface ImageGate {
  readonly limits: ImageLimits | null;
  readonly canAttach: boolean;
}

const be16 = (bytes: Uint8Array, at: number) => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
const le16 = (bytes: Uint8Array, at: number) => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
const le24 = (bytes: Uint8Array, at: number) => le16(bytes, at) | ((bytes[at + 2] ?? 0) << 16);
const be32 = (bytes: Uint8Array, at: number) => be16(bytes, at) * 0x10000 + be16(bytes, at + 2);
const ascii = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.subarray(at, at + length));

const jpegSize = (bytes: Uint8Array) => {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC), hold the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: be16(bytes, at + 7), height: be16(bytes, at + 5) };
    }
    at += 2 + be16(bytes, at + 2);
  }
  return null;
};

const webpSize = (bytes: Uint8Array) => {
  switch (ascii(bytes, 12, 4)) {
    case 'VP8X':
      return { width: le24(bytes, 24) + 1, height: le24(bytes, 27) + 1 };
    case 'VP8 ':
      return { width: le16(bytes, 26) & 0x3fff, height: le16(bytes, 28) & 0x3fff };
    case 'VP8L': {
      const bits = (bytes[21] ?? 0) | ((bytes[22] ?? 0) << 8) | ((bytes[23] ?? 0) << 16);
      return {
        width: (bits & 0x3fff) + 1,
        height: (((bits >> 14) | ((bytes[24] ?? 0) << 10)) & 0x3fff) + 1,
      };
    }
    default:
      return null;
  }
};

/** The pixel size an image's header declares, or null when the bytes are not a PNG, JPEG, GIF or WebP image. */
export const imageSize = (bytes: Uint8Array): { width: number; height: number } | null => {
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG' && ascii(bytes, 12, 4) === 'IHDR') {
    return { width: be32(bytes, 16), height: be32(bytes, 20) };
  }
  if (ascii(bytes, 0, 4) === 'GIF8') return { width: le16(bytes, 6), height: le16(bytes, 8) };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes);
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return webpSize(bytes);
  return null;
};

const base64Of = (bytes: Uint8Array): string => {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
};

/** Reads a file offered to the Composer. Files of other types are not read. */
export const readCandidate = async (file: File): Promise<Candidate> => {
  if (!IMAGE_TYPES.includes(file.type)) {
    return { name: file.name, mimeType: file.type, data: '', size: null };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { name: file.name, mimeType: file.type, data: base64Of(bytes), size: imageSize(bytes) };
};

/**
 * Which offered files become Images, with `attached` Images already in the Composer. Never resizes: an image over a
 * limit is refused, and so is every image past the count a Message can hold.
 */
export const admitImages = (
  attached: number,
  candidates: ReadonlyArray<Candidate>,
  gate: ImageGate,
): { accepted: ReadonlyArray<Attached>; refusals: ReadonlyArray<Refusal> } => {
  const accepted: Array<Attached> = [];
  const refusals: Array<Refusal> = [];
  const { limits } = gate;
  for (const { size, ...image } of candidates) {
    if (!IMAGE_TYPES.includes(image.mimeType) || size === null) {
      refusals.push({ kind: 'notImage' });
    } else if (!gate.canAttach) {
      refusals.push({ kind: 'cantTake' });
    } else if (limits !== null && image.data.length > limits.maxBase64Bytes) {
      refusals.push({ kind: 'tooLarge', name: image.name, maxBase64Bytes: limits.maxBase64Bytes });
    } else if (limits !== null && Math.max(size.width, size.height) > limits.maxDimensionPx) {
      refusals.push({ kind: 'tooWide', name: image.name, maxDimensionPx: limits.maxDimensionPx });
    } else if (limits !== null && attached + accepted.length >= limits.maxPerMessage) {
      if (!refusals.some((refusal) => refusal.kind === 'tooMany')) {
        refusals.push({ kind: 'tooMany', maxPerMessage: limits.maxPerMessage });
      }
    } else {
      accepted.push(image);
    }
  }
  return { accepted, refusals };
};

/** The Images of a Message as parts, first in `parts` (spec 5.3). */
export const imageParts = (images: ReadonlyArray<Attached>): ReadonlyArray<ImagePart> =>
  images.map(({ mimeType, data }) => ({ _tag: 'image', mimeType, data }));

/** An Image as a URL an `<img>` can show. */
export const imageUrl = (image: { readonly mimeType: string; readonly data: string }): string =>
  `data:${image.mimeType};base64,${image.data}`;
