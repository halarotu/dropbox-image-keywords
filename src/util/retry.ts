/** Exponential backoff with jitter: ~1 min, 4 min, 16 min, ... capped at 6 h. */
export function nextAttemptDelayMs(attempts: number): number {
  const base = 60_000 * Math.pow(4, Math.max(0, attempts - 1));
  const capped = Math.min(base, 6 * 60 * 60_000);
  return Math.round(capped * (0.8 + Math.random() * 0.4));
}
