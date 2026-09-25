/**
 * Longest Retry-After delay the connector will honor. This one-day operational
 * ceiling is intentionally well below the signed 32-bit timer limit.
 */
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;

export type ParsedRetryAfter =
  | { readonly kind: 'absent' }
  | { readonly kind: 'delay'; readonly milliseconds: number }
  | { readonly kind: 'invalid' };

export function parseRetryAfter(value: string | null, nowMs: number): ParsedRetryAfter {
  if (value === null) return { kind: 'absent' };

  const trimmed = value.trim();
  let milliseconds: number;
  if (/^\d+$/.test(trimmed)) {
    milliseconds = Number(trimmed) * 1_000;
  } else {
    // Keep numeric-looking values such as negatives and decimals out of the
    // permissive Date.parse fallback.
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) return { kind: 'invalid' };
    const date = Date.parse(trimmed);
    if (!Number.isFinite(date)) return { kind: 'invalid' };
    milliseconds = Math.max(0, date - nowMs);
  }

  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > MAX_RETRY_AFTER_MS) {
    return { kind: 'invalid' };
  }
  return { kind: 'delay', milliseconds };
}
