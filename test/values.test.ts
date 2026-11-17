import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dateFrom, numberFrom } from "../src/values.js";

describe("dateFrom", () => {
  const originalTz = process.env.TZ;
  beforeEach(() => {
    // Pin a zone far from UTC, so any accidental local-time parsing shows up.
    process.env.TZ = "Pacific/Honolulu";
  });
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("reads Unix seconds and milliseconds in plausible ranges", () => {
    expect(dateFrom(1_700_000_000)).toBe(1_700_000_000_000);
    expect(dateFrom(1_700_000_000_123)).toBe(1_700_000_000_123);
    expect(dateFrom("1700000000")).toBe(1_700_000_000_000);
  });

  it("ignores numbers that are not plausible timestamps, such as 20240301", () => {
    expect(dateFrom(20_240_301)).toBeUndefined();
    expect(dateFrom(0)).toBeUndefined();
    expect(dateFrom(-5)).toBeUndefined();
    expect(dateFrom(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("reads ISO date-times only with an offset, independent of the server's zone", () => {
    expect(dateFrom("2026-01-03T15:04:05Z")).toBe(Date.UTC(2026, 0, 3, 15, 4, 5));
    expect(dateFrom("2026-01-03T15:04:05.250+02:00")).toBe(Date.UTC(2026, 0, 3, 13, 4, 5, 250));
    expect(dateFrom("2026-01-03T15:04:05")).toBeUndefined();
    expect(dateFrom("Jan 3 2026")).toBeUndefined();
  });

  it.each(["2024-02-30T10:00:00Z", "2026-01-03T24:00:00Z", "2026-01-03T10:60:00Z", "2026-01-03T10:00:61Z", "2026-13-01T00:00:00Z", "2026-01-03T10:00:00+25:00"])(
    "rejects the impossible date-time %s instead of rolling it over",
    (value) => {
      expect(dateFrom(value)).toBeUndefined();
    },
  );

  it("accepts a real leap day with an offset", () => {
    expect(dateFrom("2024-02-29T10:00:00+05:00")).toBe(Date.UTC(2024, 1, 29, 5));
  });

  it("reads date-only strings as midnight UTC and rejects impossible dates", () => {
    expect(dateFrom("2026-03-01")).toBe(Date.UTC(2026, 2, 1));
    expect(dateFrom("2026-02-31")).toBeUndefined();
  });

  it("returns the first readable argument", () => {
    expect(dateFrom(undefined, "nope", 1_700_000_000)).toBe(1_700_000_000_000);
    expect(dateFrom(null, {})).toBeUndefined();
  });
});

describe("numberFrom", () => {
  it.each([
    ["1234", 1234],
    ["1,234.50", 1234.5],
    ["$12,500.00", 12_500],
    ["-$12", -12],
    ["(1,500.00)", -1500],
    [" 42 ", 42],
  ])("reads %j as %d", (input, expected) => {
    expect(numberFrom(input)).toBe(expected);
  });

  it.each(["1,2,3", "12,34", "abc", "", "1.2.3", "$", "(-5)", "(-$5)"])("rejects %j", (input) => {
    expect(numberFrom(input)).toBeUndefined();
  });

  it("passes finite numbers through and skips the rest", () => {
    expect(numberFrom(Number.NaN, "x", 7)).toBe(7);
  });
});
