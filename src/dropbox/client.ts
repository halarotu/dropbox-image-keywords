import { Dropbox, DropboxResponseError } from "dropbox";
import type { Config } from "../config";

/**
 * Creates a Dropbox client that refreshes short-lived access tokens automatically
 * from the long-lived refresh token.
 */
export function createDropboxClient(cfg: Config): Dropbox {
  return new Dropbox({
    clientId: cfg.DROPBOX_APP_KEY,
    clientSecret: cfg.DROPBOX_APP_SECRET,
    refreshToken: cfg.DROPBOX_REFRESH_TOKEN,
  });
}

/** Shape of the JSON body Dropbox returns for 409 "endpoint-specific" errors. */
interface DropboxApiErrorBody {
  error_summary?: string;
  error?: { ".tag"?: string; [k: string]: unknown };
}

export function isDropboxError(err: unknown): err is DropboxResponseError<DropboxApiErrorBody> {
  return err instanceof DropboxResponseError;
}

/** e.g. "path/not_found/.." or "reset/..". Empty string when unavailable. */
export function dropboxErrorSummary(err: unknown): string {
  if (!isDropboxError(err)) return "";
  const body = err.error as DropboxApiErrorBody | string | undefined;
  if (typeof body === "string") return body;
  return body?.error_summary ?? "";
}

export function isRateLimited(err: unknown): boolean {
  return isDropboxError(err) && err.status === 429;
}
