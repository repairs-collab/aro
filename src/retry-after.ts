/**
 * Longest Retry-After delay the connector will honor. This one-day operational
 * ceiling is intentionally well below the signed 32-bit timer limit.
 */
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;

export type ParsedRetryAfter =
  | { readonly kind: 'absent' }
  | { readonly kind: 'delay'; readonly milliseconds: number }
  | { readonly kind: 'invalid' };

const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const LONG_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function utcTimestamp(
  weekday: string,
  year: number,
  monthName: string,
  day: number,
  hour: number,
  minute: number,
  second: number
): number | undefined {
  const month = MONTHS.indexOf(monthName as (typeof MONTHS)[number]);
  const weekdayIndex = SHORT_WEEKDAYS.indexOf(weekday as (typeof SHORT_WEEKDAYS)[number]);
  if (year < 1601 || month < 0 || weekdayIndex < 0 || day < 1 || day > 31
    || hour > 23 || minute > 59 || second > 59) return undefined;

  const timestamp = Date.UTC(year, month, day, hour, minute, second);
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second
    || date.getUTCDay() !== weekdayIndex) return undefined;
  return timestamp;
}

function parseHttpDate(value: string, nowMs: number): number | undefined {
  const imf = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  if (imf !== null) {
    return utcTimestamp(imf[1]!, Number(imf[4]), imf[3]!, Number(imf[2]), Number(imf[5]), Number(imf[6]), Number(imf[7]));
  }

  const rfc850 = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  if (rfc850 !== null) {
    const currentYear = new Date(nowMs).getUTCFullYear();
    let year = Math.floor(currentYear / 100) * 100 + Number(rfc850[4]);
    if (year > currentYear + 50) year -= 100;
    const weekdayIndex = LONG_WEEKDAYS.indexOf(rfc850[1] as (typeof LONG_WEEKDAYS)[number]);
    return utcTimestamp(SHORT_WEEKDAYS[weekdayIndex] ?? '', year, rfc850[3]!, Number(rfc850[2]), Number(rfc850[5]), Number(rfc850[6]), Number(rfc850[7]));
  }

  const asctime = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value);
  if (asctime === null) return undefined;
  return utcTimestamp(asctime[1]!, Number(asctime[7]), asctime[2]!, Number(asctime[3]), Number(asctime[4]), Number(asctime[5]), Number(asctime[6]));
}

export function parseRetryAfter(value: string | null, nowMs: number): ParsedRetryAfter {
  if (value === null) return { kind: 'absent' };

  const trimmed = value.trim();
  let milliseconds: number;
  if (/^\d+$/.test(trimmed)) {
    milliseconds = Number(trimmed) * 1_000;
  } else {
    // Keep numeric-looking values such as negatives and decimals out of the
    // date fallback, then accept only the three HTTP-date wire formats.
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) return { kind: 'invalid' };
    const timestamp = parseHttpDate(trimmed, nowMs);
    if (timestamp === undefined) return { kind: 'invalid' };
    milliseconds = Math.max(0, timestamp - nowMs);
  }

  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > MAX_RETRY_AFTER_MS) {
    return { kind: 'invalid' };
  }
  return { kind: 'delay', milliseconds };
}
