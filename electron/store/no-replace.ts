import { link } from 'node:fs/promises';

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
