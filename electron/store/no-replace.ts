import { link } from 'node:fs/promises';

/**
 * Publishes a hard link without replacing an existing target. Source and target
 * refer to the same inode, so writes through either name or an open handle change
 * both. Callers must control and close writable handles and trust the directories
 * and that source is a regular file.
 *
 * Exists only means the target already exists; it does not verify its contents.
 * Unsupported hard links, cross-device links, and other errors propagate. This
 * operation provides no durability guarantee.
 */
export const publishNoReplace = async (
  source: string,
  target: string,
): Promise<'Published' | 'Exists'> => {
  try {
    await link(source, target);
    return 'Published';
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
      return 'Exists';
    }
    throw error;
  }
};
