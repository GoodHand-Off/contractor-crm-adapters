/** Small coercion helpers for loosely typed CRM payloads. Internal. */

export type JsonObject = Record<string, unknown>;

/** First argument that is a non-blank string (trimmed) or a finite number (stringified). */
export function stringFrom(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/** "1234", "1,234.50", "$1,234.50", "-$12", "(1,500.00)" (accounting negative). Rejects "1,2,3". */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
const GROUPED_NUMBER = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;

/** First argument that is a finite number, or a numeric string such as "$12,500.00" or "(1,500.00)". */
export function numberFrom(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") continue;
    let text = value.trim();
    let sign = 1;
    const parens = /^\((.+)\)$/.exec(text);
    if (parens?.[1]) {
      sign = -1;
      text = parens[1].trim();
      if (text.startsWith("-")) continue; // "(-5)" is not a valid accounting negative
    }
    text = text.replace(/^(-?)\$/, "$1");
    if (PLAIN_NUMBER.test(text) || GROUPED_NUMBER.test(text)) {
      const parsed = sign * Number(text.replace(/,/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/** ISO 8601 date-time with an explicit offset; a string without one would depend on the server's time zone. */
const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):?(\d{2}))$/i;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Unix seconds from 2001-09-09 to 2286-11-20. Smaller numbers (e.g. 20240301) are not treated as dates. */
const SECONDS_MIN = 1e9;
const SECONDS_MAX = 1e10;
/** Unix milliseconds over the same span. */
const MILLIS_MIN = 1e12;
const MILLIS_MAX = 1e13;

/**
 * First argument that reads unambiguously as a date, returned as Unix ms.
 *
 * - Numbers (or digit strings) from 1e9 to 1e10 are Unix seconds; 1e12 to 1e13 are Unix ms. Others are ignored.
 * - ISO 8601 date-times must carry an offset ("Z" or "+02:00").
 * - Date-only strings ("2026-03-01") are midnight UTC.
 *
 * Anything else, including date-times without an offset, is ignored rather than guessed.
 */
export function dateFrom(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = typeof value === "number" ? fromEpoch(value) : typeof value === "string" ? fromString(value) : undefined;
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function fromEpoch(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  if (value >= SECONDS_MIN && value < SECONDS_MAX) return Math.round(value * 1000);
  if (value >= MILLIS_MIN && value < MILLIS_MAX) return Math.round(value);
  return undefined;
}

function fromString(value: string): number | undefined {
  const text = value.trim();
  if (/^\d+$/.test(text)) return fromEpoch(Number(text));
  const iso = ISO_WITH_OFFSET.exec(text);
  if (iso) {
    const [, y, mo, d, h, mi, s = "0", oh = "0", om = "0"] = iso;
    // Reject impossible parts (2024-02-30, 24:00, +25:00) instead of letting Date.parse roll them over.
    if (!isRealDay(Number(y), Number(mo), Number(d)) || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return undefined;
    if (Number(oh) > 23 || Number(om) > 59) return undefined;
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly) {
    const [y, mo, d] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])];
    return isRealDay(y, mo, d) ? Date.UTC(y, mo - 1, d) : undefined;
  }
  return undefined;
}

/** `true` when the year-month-day exists on the calendar (Date.UTC would roll 2026-02-31 into March). */
function isRealDay(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function objectFrom(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

export function objectsFrom(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter((item): item is JsonObject => objectFrom(item) !== undefined) : [];
}

/** Drop keys whose value is `undefined`; return `undefined` if nothing is left. */
export function compact<T extends object>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
}
