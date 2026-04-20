import type {
  FilesRemoveRequest,
  FilesRemoveResponse,
} from "@ft5/ipc-contracts";

import { remove } from "./mock-fs.js";

export function handleFilesRemove(req: FilesRemoveRequest): FilesRemoveResponse {
  return remove(req);
}
