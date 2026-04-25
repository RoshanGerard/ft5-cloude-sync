// add-file-explorer-drag-drop-upload task 2.4 — native multi-select
// picker handler [GREEN].
//
// Opens the OS "Open File" dialog in multi-select mode and returns the
// selection verbatim as `{ canceled, filePaths }`. The handler does
// NOT enqueue an upload and does NOT know the datasource — the
// renderer then calls `files.upload` for each picked path. Separating
// the picker from the enqueue is what lets the drag-drop and
// dialog-destination-picker flows share the same upload code path: in
// both cases the renderer ends up with a list of OS paths and a
// target datasource folder.
//
// The `showOpenDialog` call itself lives in `ipc/index.ts` (with the
// correct `properties: ["openFile", "multiSelections"]` flags) so the
// handler module stays free of the Electron `dialog` import and can
// be unit-tested under plain Node. We defensively clone `filePaths`
// because Electron's `OpenDialogReturnValue.filePaths` is a mutable
// `string[]` — the contract shape on the renderer side is
// `readonly string[]`, so a later mutation of the OS buffer would be
// a subtle bug.

import type { DatasourcesPickFilesResponse } from "@ft5/ipc-contracts";

export interface PickFilesToUploadDeps {
  readonly showOpenDialog: () => Promise<{
    canceled: boolean;
    filePaths: string[];
  }>;
}

export async function handlePickFilesToUpload(
  deps: PickFilesToUploadDeps,
): Promise<DatasourcesPickFilesResponse> {
  const result = await deps.showOpenDialog();
  return {
    canceled: result.canceled,
    filePaths: [...result.filePaths],
  };
}
