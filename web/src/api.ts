export type SearchMode = "all" | "any";

export interface Image {
  id: string;
  name: string;
  path: string;
  keywords: string[];
  modifiedAt: string;
  contentHash: string;
}

export interface SearchResult {
  terms: string[];
  items: Image[];
  nextCursor: string | null;
}

/** IAP's sign-in has expired; a full page load sends the user through Google sign-in again. */
export class SessionExpiredError extends Error {
  constructor() {
    super("Your sign-in has expired.");
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  // An expired IAP session answers with a redirect to Google sign-in, which fetch can't follow.
  const res = await fetch(url, { signal, redirect: "manual" });
  if (res.type === "opaqueredirect" || res.status === 401) throw new SessionExpiredError();
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return res.json();
}

export function searchImages(
  q: string,
  mode: SearchMode,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<SearchResult> {
  const params = new URLSearchParams({ q, mode, limit: "48" });
  if (cursor) params.set("cursor", cursor);
  return getJson(`/api/search?${params}`, signal);
}

export function thumbnailUrl(img: Image, size: "small" | "large"): string {
  return `/api/images/${encodeURIComponent(img.id)}/thumbnail?size=${size}&v=${encodeURIComponent(img.contentHash)}`;
}
