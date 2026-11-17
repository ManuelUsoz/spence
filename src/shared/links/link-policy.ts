/** The longest destination Spence considers a link at all. */
const MAX_URL_LENGTH = 8_192;

/**
 * Whether `value` may leave the app for the user's browser: an absolute HTTPS URL with a host and no credentials.
 * Everything else (relative paths, fragments, other schemes, `user:pass@host`) stays plain text.
 */
export const isAllowedExternalUrl = (value: string): boolean => {
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  // URL parsing trims surrounding whitespace; a link in prose should not hide any.
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  return url.hostname !== '';
};
