import type {
  FilesRenameRequest,
  FilesRenameResponse,
} from "@ft5/ipc-contracts";

import { rename } from "./mock-fs.js";

export function handleFilesRename(req: FilesRenameRequest): FilesRenameResponse {
  return rename(req);
}
