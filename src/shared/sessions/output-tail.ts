/** Maximum retained UTF-8 byte length for a Step's rolling command output tail. */
export const MAX_STEP_OUTPUT_BYTES = 32_768;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

/** Keeps the trailing `maxBytes` of `text`, advancing past any partial leading UTF-8 sequence. */
export const capOutputTail = (
  text: string,
  maxBytes = MAX_STEP_OUTPUT_BYTES,
): { readonly text: string; readonly truncated: boolean } => {
  const limit = Math.max(0, Math.floor(maxBytes));
  const bytes = utf8Encoder.encode(text);
  if (bytes.byteLength <= limit) return { text, truncated: false };
  if (limit === 0) return { text: '', truncated: true };
  let start = bytes.byteLength - limit;
  while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return { text: utf8Decoder.decode(bytes.subarray(start)), truncated: true };
};
