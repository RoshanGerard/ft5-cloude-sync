import type { FilesStatRequest, FilesStatResponse } from "@ft5/ipc-contracts";

import { stat } from "./mock-fs.js";

export function handleFilesStat(req: FilesStatRequest): FilesStatResponse {
  try {
    const entry = stat(req);
    return { ok: true, value: { entry } };
  } catch (err) {
    // The mock-fs `stat` helper throws when the datasource or path is
    // missing; widen the raw throw into the tagged envelope so the renderer
    // can surface a targeted error instead of an `ipcRenderer.invoke` reject.
    return {
      ok: false,
      error: {
        tag: "other",
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      },
    };
  }
}
