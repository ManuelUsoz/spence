/** What makes two folder paths the same Project folder: exact on POSIX, case-insensitive on Windows. */
export const folderKey = (folder: string, platform: NodeJS.Platform): string =>
  platform === 'win32' ? folder.toLowerCase() : folder;
