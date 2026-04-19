import type { FilesStatRequest, FilesStatResponse } from "@ft5/ipc-contracts";

import { stat } from "./mock-fs.js";

export function handleFilesStat(req: FilesStatRequest): FilesStatResponse {
  const entry = stat(req);
  return { entry };
}
