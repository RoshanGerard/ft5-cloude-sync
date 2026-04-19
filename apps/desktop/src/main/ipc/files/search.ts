import type {
  FilesSearchRequest,
  FilesSearchResponse,
} from "@ft5/ipc-contracts";

import { search } from "./mock-fs.js";

export function handleFilesSearch(req: FilesSearchRequest): FilesSearchResponse {
  return search(req);
}
