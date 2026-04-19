import type {
  FilesDownloadRequest,
  FilesDownloadResponse,
} from "@ft5/ipc-contracts";

import { download } from "./mock-fs.js";

export function handleFilesDownload(
  req: FilesDownloadRequest,
): FilesDownloadResponse {
  return download(req);
}
