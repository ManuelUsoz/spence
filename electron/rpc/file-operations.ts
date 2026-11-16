import { FileOperationRpcs } from '../../src/shared/files/file-operations.rpc';
import { FileOperations } from '../files/file-operations';

/** Handler layer for reviewed, durable create/rename/delete file operations. */
export const layerFileOperationHandlers = FileOperationRpcs.toLayer({
  'FileOperations.reviewCreate': ({ target, dirPath, name, kind }) =>
    FileOperations.use((ops) => ops.reviewCreate({ target, dirPath, name, kind })),
  'FileOperations.reviewRename': ({ target, relativePath, newName }) =>
    FileOperations.use((ops) => ops.reviewRename({ target, relativePath, newName })),
  'FileOperations.reviewDelete': ({ target, relativePaths }) =>
    FileOperations.use((ops) => ops.reviewDelete({ target, relativePaths })),
  'FileOperations.execute': ({ reviewId, operationId, allowPermanentDelete }) =>
    FileOperations.use((ops) =>
      ops.execute({
        reviewId,
        operationId,
        ...(allowPermanentDelete === undefined ? {} : { allowPermanentDelete }),
      }),
    ),
});
