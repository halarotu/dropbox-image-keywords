import type { Dropbox, files } from "dropbox";

export type ThumbnailSize = files.ThumbnailSize[".tag"];

/** A JPEG thumbnail of the image, scaled to fit inside `size`. */
export async function fetchThumbnail(dbx: Dropbox, dropboxId: string, size: ThumbnailSize): Promise<Buffer> {
  const res = await dbx.filesGetThumbnailV2({
    resource: { ".tag": "path", path: dropboxId },
    format: { ".tag": "jpeg" },
    size: { ".tag": size },
    mode: { ".tag": "bestfit" },
  });
  const bin = res.result.fileBinary;
  if (!bin) throw new Error("Dropbox returned no thumbnail data");
  return Buffer.from(bin);
}
