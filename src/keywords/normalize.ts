/**
 * Normalises raw model output so keywords are consistent and searchable:
 * NFKC + lowercase, trimmed, punctuation at the edges removed, whitespace collapsed, deduped.
 */
export function normalizeKeywords(raw: readonly string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of raw) {
    const clean = k
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/\s+/g, " ")
      .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "")
      .trim();
    if (!clean || clean.length > 60 || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Search terms = every keyword plus each of its words, so a search for "retriever"
 * finds an image tagged "golden retriever". Firestore's array-contains / array-contains-any
 * queries run against this field.
 */
export function buildSearchTerms(keywords: readonly string[]): string[] {
  const terms = new Set<string>(keywords);
  for (const k of keywords) {
    for (const word of k.split(/[\s\-/]+/)) {
      const w = word.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
      if (w.length >= 2) terms.add(w);
    }
  }
  return [...terms];
}
