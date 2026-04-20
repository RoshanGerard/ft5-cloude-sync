import type { FilesListRequest, FilesListResponse } from "@ft5/ipc-contracts";

import { list } from "./mock-fs.js";

export function handleFilesList(req: FilesListRequest): FilesListResponse {
  return list(req);
}
