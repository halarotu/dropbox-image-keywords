import type { files } from "dropbox";

export type FileEntry = files.FileMetadataReference;
export type DeletedEntry = files.DeletedMetadataReference;
export type ListEntry = files.ListFolderResult["entries"][number];

export function isFile(e: ListEntry): e is FileEntry {
  return e[".tag"] === "file";
}

export function isDeleted(e: ListEntry): e is DeletedEntry {
  return e[".tag"] === "deleted";
}

export function hasImageExtension(name: string, extensions: readonly string[]): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return extensions.includes(name.slice(dot + 1).toLowerCase());
}

/** Dropbox file ids look like "id:AbC123..."; strip the prefix for a Firestore doc id. */
export function docIdForDropboxId(dropboxId: string): string {
  return dropboxId.replace(/^id:/, "");
}
