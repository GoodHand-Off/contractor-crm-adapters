import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient, parseRateLimitReset, parseRetryAfter } from "../src/http.js";
import {
  CrmAuthError,
  CrmHttpError,
  CrmNetworkError,
  CrmNotFoundError,
  CrmRateLimitError,
  CrmResponseError,
  CrmTimeoutError,
  CrmValidationError,
  AccuLynxClient,
  HousecallProClient,
  JobNimbusClient,
  RequestLimiter,
} from "../src/index.js";
import { TEST_API_KEY, hang, json, jsonLater, mockFetch, text } from "./helpers.js";

const DEFAULTS = { baseUrl: "https://crm.example.com/api", minRequestIntervalMs: 0 };

function client(fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) {
  return new HttpClient("jobnimbus", DEFAULTS, { apiKey: TEST_API_KEY, fetch, ...extra });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HttpClient requests", () => {
  it("sends the key as a Bearer token and encodes the query", async () => {
    const { fetch, calls } = mockFetch(json({ ok: true }));
    const result = await client(fetch).request("/things", { query: { size: 2, filter: '{"a":1}', skip: undefined } });

    expect(result).toEqual({ ok: true });
    expect(String(calls[0]?.url).split("?")[0]).toBe("https://crm.example.com/api/things");
    expect(calls[0]?.url.searchParams.get("size")).toBe("2");
    expect(calls[0]?.url.searchParams.get("filter")).toBe('{"a":1}');
    expect(calls[0]?.url.searchParams.has("skip")).toBe(false);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TEST_API_KEY}`);
    expect(calls[0]?.headers["content-type"]).toBeUndefined();
  });

  it("serializes a JSON body for POST", async () => {
    const { fetch, calls } = mockFetch(json({ id: "x" }));
    await client(fetch).request("/things", { method: "POST", body: { a: 1 } });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(calls[0]?.body).toEqual({ a: 1 });
  });

  it("returns undefined for an empty 2xx body", async () => {
    const { fetch } = mockFetch(text("", 200));
    await expect(client(fetch).request("/things")).resolves.toBeUndefined();
  });

  it("throws CrmResponseError for a non-JSON 2xx body", async () => {
    const { fetch } = mockFetch(text("<html>oops</html>", 200));
    await expect(client(fetch).request("/things")).rejects.toBeInstanceOf(CrmResponseError);
  });

  it("requires a non-blank API key", () => {
    expect(() => new HttpClient("jobnimbus", DEFAULTS, { apiKey: " " })).toThrow(CrmValidationError);
  });
});

describe("HttpClient errors", () => {
  it.each([
    [401, CrmAuthError],
    [403, CrmAuthError],
    [404, CrmNotFoundError],
    [400, CrmHttpError],
    [500, CrmHttpError],
  ])("maps HTTP %i to %o without retrying", async (status, ErrorClass) => {
    const { fetch, calls } = mockFetch(text("upstream said something sensitive", status));
    const error = await client(fetch).request("/things").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ErrorClass);
    expect(calls).toHaveLength(1);
    const httpError = error as CrmHttpError;
    expect(httpError.status).toBe(status);
    expect(httpError.path).toBe("/things");
    expect(httpError.responseBody).toBe("upstream said something sensitive");
    expect(httpError.message).not.toContain("sensitive");
    expect(httpError.message).not.toContain(TEST_API_KEY);
  });

  it("wraps a fetch rejection in CrmNetworkError and does not retry", async () => {
    const { fetch, calls } = mockFetch(() => {
      throw new TypeError("connection reset");
    });
    const error = await client(fetch).request("/things").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CrmNetworkError);
    expect((error as Error).cause).toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(1);
  });

  it("times out with CrmTimeoutError and does not retry", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = mockFetch(hang());
    const pending = client(fetch, { timeoutMs: 5_000 }).request("/slow");
    const assertion = expect(pending).rejects.toBeInstanceOf(CrmTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(calls).toHaveLength(1);
  });

  it("passes a caller abort through unchanged", async () => {
    const { fetch } = mockFetch(hang());
    const controller = new AbortController();
    const pending = client(fetch).request("/slow", { signal: controller.signal });
    controller.abort(new Error("caller cancelled"));
    await expect(pending).rejects.toThrow("caller cancelled");
  });
});

describe("HttpClient rate limits", () => {
  it("waits for Retry-After seconds, then retries once", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = mockFetch(text("slow down", 429, { "retry-after": "3" }), json({ ok: true }));
    const pending = client(fetch).request("/things");

    await vi.advanceTimersByTimeAsync(2_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("retries a POST that was rate limited, since 429 means it was not processed", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = mockFetch(text("", 429, { "retry-after": "1" }), json({ jnid: "x" }));
    const pending = client(fetch).request("/things", { method: "POST", body: { a: 1 } });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ jnid: "x" });
    expect(calls.map((c) => c.method)).toEqual(["POST", "POST"]);
  });

  it("backs off 1s then 2s without Retry-After and stops after maxRetries", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = mockFetch(text("", 429), text("", 429), text("", 429));
    const pending = client(fetch).request("/things");
    const assertion = expect(pending).rejects.toBeInstanceOf(CrmRateLimitError);

    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(calls).toHaveLength(3);
  });

  it("throws at once when Retry-After is longer than maxRetryDelayMs", async () => {
    const { fetch, calls } = mockFetch(text("", 429, { "retry-after": "120" }));
    const error = await client(fetch, { maxRetryDelayMs: 60_000 }).request("/things").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CrmRateLimitError);
    expect((error as CrmRateLimitError).retryAfterMs).toBe(120_000);
    expect(calls).toHaveLength(1);
  });

  it("never retries when maxRetries is 0", async () => {
    const { fetch, calls } = mockFetch(text("", 429, { "retry-after": "1" }));
    await expect(client(fetch, { maxRetries: 0 }).request("/things")).rejects.toBeInstanceOf(CrmRateLimitError);
    expect(calls).toHaveLength(1);
  });

  it("retries 503 only when the server sends Retry-After", async () => {
    vi.useFakeTimers();
    const first = mockFetch(text("", 503));
    await expect(client(first.fetch).request("/things")).rejects.toMatchObject({ status: 503 });
    expect(first.calls).toHaveLength(1);

    const second = mockFetch(text("", 503, { "retry-after": "2" }), json({ ok: true }));
    const pending = client(second.fetch).request("/things");
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("cancels a pending retry wait when the caller aborts", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = mockFetch(text("", 429, { "retry-after": "30" }));
    const controller = new AbortController();
    const pending = client(fetch).request("/things", { signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow("stop");
    await vi.advanceTimersByTimeAsync(10);
    controller.abort(new Error("stop"));
    await assertion;
    expect(calls).toHaveLength(1);
  });

  it("spaces requests by minRequestIntervalMs, even when called concurrently", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = mockFetch(json({}), json({}), json({}));
    const http = client(fetch, { minRequestIntervalMs: 100 });
    const all = Promise.all([http.request("/a"), http.request("/b"), http.request("/c")]);

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(100);
    await all;
    expect(calls.map((c) => c.url.pathname)).toEqual(["/api/a", "/api/b", "/api/c"]);
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");

  it("reads delta-seconds", () => {
    expect(parseRetryAfter("7", now)).toBe(7_000);
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter("1.5", now)).toBe(1_500);
  });

  it("reads an HTTP-date relative to now, never negative", () => {
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", now)).toBe(10_000);
    expect(parseRetryAfter("Wed, 31 Dec 2025 23:59:00 GMT", now)).toBe(0);
  });

  it("ignores missing or unreadable values", () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter("", now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter("-5", now)).toBeUndefined();
  });
});

describe("error messages", () => {
  it("say what to do next and never include the key", async () => {
    const cases: Array<[Response, RegExp]> = [
      [text("", 401), /API key is invalid, revoked or lacks permission\. Create a key in JobNimbus/],
      [text("", 404), /record does not exist or the key cannot see it/],
      [text("", 429), /wait before retrying/],
      [text("", 500), /HTTP 500 for GET \/things\.$/],
      [text("details", 500), /The response body is on error\.responseBody\./],
    ];
    for (const [reply, message] of cases) {
      const { fetch } = mockFetch(reply);
      const error = await client(fetch, { maxRetries: 0 }).request("/things").catch((e: unknown) => e);
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toContain(TEST_API_KEY);
    }
  });

  it("name the timeout and the option to raise it", async () => {
    vi.useFakeTimers();
    const { fetch } = mockFetch(hang());
    const pending = client(fetch, { timeoutMs: 1_000 }).request("/slow");
    const assertion = expect(pending).rejects.toThrow(/within 1000 ms\. Retry later, or raise the timeoutMs option\./);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("point a network failure at network access and baseUrl", async () => {
    const { fetch } = mockFetch(() => {
      throw new TypeError("getaddrinfo failed");
    });
    await expect(client(fetch).request("/things")).rejects.toThrow(/Check network access and the baseUrl option/);
  });

  it("reject before sending when the signal is already aborted", async () => {
    const { fetch, calls } = mockFetch();
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    await expect(client(fetch).request("/things", { signal: controller.signal })).rejects.toThrow("already cancelled");
    expect(calls).toHaveLength(0);
  });

  it("send the User-Agent when set", async () => {
    const { fetch, calls } = mockFetch(json({}));
    await client(fetch, { userAgent: "example-app/1.0" }).request("/things");
    expect(calls[0]?.headers["user-agent"]).toBe("example-app/1.0");
  });
});

describe("the API key stays private", () => {
  const MARKER = "marker-key-42";

  it("never appears in util.inspect or JSON.stringify of a client", () => {
    const { fetch } = mockFetch();
    const clients = [
      new JobNimbusClient({ apiKey: MARKER, fetch }),
      new AccuLynxClient({ apiKey: MARKER, fetch }),
      new HousecallProClient({ apiKey: MARKER, fetch }),
      new HttpClient("jobnimbus", DEFAULTS, { apiKey: MARKER, fetch }),
    ];
    for (const crm of clients) {
      expect(inspect(crm, { depth: Infinity, showHidden: true, getters: true })).not.toContain(MARKER);
      expect(JSON.stringify(crm)).not.toContain(MARKER);
      expect(inspect({ crm }, { depth: Infinity })).not.toContain(MARKER);
    }
  });
});

describe("rate-limit pauses are client-wide", () => {
  it("holds concurrent requests already queued when one gets a 429", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = mockFetch(text("", 429, { "retry-after": "1" }), json({}), json({}), json({}));
    const http = client(fetch, { minRequestIntervalMs: 100 });
    const all = Promise.all([http.request("/a"), http.request("/b"), http.request("/c")]);

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1); // /b and /c were due at 100 and 200 ms, but the pause holds them
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    await all;
    expect(calls).toHaveLength(4);
  });

  it("holds a request made after the 429, even with no spacing", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = mockFetch(text("", 429, { "retry-after": "2" }), json({ first: true }), json({ second: true }));
    const http = client(fetch);
    const first = http.request("/a");
    await vi.advanceTimersByTimeAsync(0);
    const second = http.request("/b");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(calls).toHaveLength(3);
  });

  it("fails fast while a pause longer than maxRetryDelayMs is in force", async () => {
    const { fetch, calls } = mockFetch(text("", 429, { "retry-after": "120" }));
    const http = client(fetch, { maxRetryDelayMs: 5_000 });
    await expect(http.request("/a")).rejects.toBeInstanceOf(CrmRateLimitError);
    const second = await http.request("/b").catch((e: unknown) => e);
    expect(second).toBeInstanceOf(CrmRateLimitError);
    expect((second as CrmRateLimitError).retryAfterMs).toBeGreaterThan(119_000);
    expect(calls).toHaveLength(1);
  });

  it("gives up after maxRetries 503s with Retry-After", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = mockFetch(
      text("", 503, { "retry-after": "1" }),
      text("", 503, { "retry-after": "1" }),
      text("", 503, { "retry-after": "1" }),
    );
    const pending = client(fetch).request("/things");
    const assertion = expect(pending).rejects.toMatchObject({ name: "CrmRateLimitError", status: 503 });
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(calls).toHaveLength(3);
  });
});

describe("RequestLimiter", () => {
  it("spaces requests across clients that share it", async () => {
    vi.useFakeTimers();
    const limiter = new RequestLimiter({ minIntervalMs: 100 });
    const { fetch, calls } = mockFetch(json({ results: [] }), json({ results: [] }), json({}), json({}));
    const jn = new JobNimbusClient({ apiKey: TEST_API_KEY, fetch, limiter });
    const al = new AccuLynxClient({ apiKey: TEST_API_KEY, fetch, limiter, minRequestIntervalMs: 0 });
    const all = Promise.all([jn.testConnection(), al.testConnection(), jn.testConnection(), al.testConnection()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    await all;
    expect(calls).toHaveLength(4);
  });

  it("shares a 429 pause with every client on the limiter", async () => {
    vi.useFakeTimers();
    const limiter = new RequestLimiter({ minIntervalMs: 0 });
    const { fetch, calls } = mockFetch(text("", 429, { "retry-after": "3" }), json({}), json({}));
    const a = new AccuLynxClient({ apiKey: TEST_API_KEY, fetch, limiter, minRequestIntervalMs: 0 });
    const b = new AccuLynxClient({ apiKey: TEST_API_KEY, fetch, limiter, minRequestIntervalMs: 0 });
    const first = a.testConnection();
    await vi.advanceTimersByTimeAsync(0);
    const second = b.testConnection();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(calls).toHaveLength(3);
  });

  it.each([Number.NaN, -1, "10", undefined, 3e9])("rejects minIntervalMs %j with a TypeError", (minIntervalMs) => {
    expect(() => new RequestLimiter({ minIntervalMs } as unknown as { minIntervalMs: number })).toThrow(TypeError);
  });
});

describe("long waits", () => {
  it("waits longer than setTimeout's limit in chunks instead of firing early", async () => {
    vi.useFakeTimers();
    const max = 2 ** 31 - 1;
    const { fetch, calls } = mockFetch(json({}), json({}), json({}));
    const http = client(fetch, { minRequestIntervalMs: max });
    // The third request is due 2 * max ms out, beyond what one setTimeout can express.
    const all = Promise.all([http.request("/a"), http.request("/b"), http.request("/c")]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(max - 1_000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(max - 1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await all;
    expect(calls).toHaveLength(3);
  });
});

describe("timeouts and cancellation", () => {
  it("times out a body that never finishes, even if fetch ignores the signal", async () => {
    vi.useFakeTimers();
    const { stalledBody } = await import("./helpers.js");
    const { fetch } = mockFetch(stalledBody());
    const pending = client(fetch, { timeoutMs: 2_000 }).request("/slow-body");
    const assertion = expect(pending).rejects.toBeInstanceOf(CrmTimeoutError);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
  });

  it("stops paging when the caller aborts mid-pagination", async () => {
    const page = Array.from({ length: 2 }, (_, i) => ({ jnid: `jn-${i}`, date_created: 1_700_000_000 + i }));
    const { fetch, calls } = mockFetch(json({ results: page }), hang());
    const controller = new AbortController();
    const jn = new JobNimbusClient({ apiKey: TEST_API_KEY, fetch });
    const seen: string[] = [];
    const run = (async () => {
      for await (const contact of jn.iterateContacts({ pageSize: 2, signal: controller.signal })) {
        seen.push(contact.externalId);
        if (seen.length === 2) setTimeout(() => controller.abort(new Error("user cancelled")), 0);
      }
    })();
    await expect(run).rejects.toThrow("user cancelled");
    expect(seen).toEqual(["jn-0", "jn-1"]);
    expect(calls).toHaveLength(2);
  });

  it("builds replies lazily when asked", async () => {
    const { fetch } = mockFetch(jsonLater(() => ({ at: "request time" })));
    await expect(client(fetch).request("/x")).resolves.toEqual({ at: "request time" });
  });
});

describe("RateLimit-Reset, for providers that document it", () => {
  const HCP_DEFAULTS = { ...DEFAULTS, authScheme: "Token" as const, rateLimitReset: true };
  const now = Date.parse("2026-01-01T00:00:00Z");
  const epoch = (secondsFromNow: number) => String(now / 1000 + secondsFromNow);

  function hcpHttp(fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) {
    return new HttpClient("housecallpro", HCP_DEFAULTS, { apiKey: TEST_API_KEY, fetch, ...extra });
  }

  // No jitter unless a test asks for it, so waits are exact.
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the key with the provider's scheme", async () => {
    const { fetch, calls } = mockFetch(json({}));
    await hcpHttp(fetch).request("/things");
    expect(calls[0]?.headers.authorization).toBe(`Token ${TEST_API_KEY}`);
  });

  it("prefers RateLimit-Reset over Retry-After", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { fetch, calls } = mockFetch(text("", 429, { "ratelimit-reset": epoch(5), "retry-after": "1" }), json({ ok: true }));
    const pending = hcpHttp(fetch).request("/things");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("backs off instead of retrying at once when the reset time has already passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { fetch, calls } = mockFetch(text("", 429, { "ratelimit-reset": epoch(-30) }), json({ ok: true }));
    const pending = hcpHttp(fetch).request("/things");
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("falls back to Retry-After when RateLimit-Reset is missing or unreadable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { fetch, calls } = mockFetch(text("", 429, { "ratelimit-reset": "soon", "retry-after": "2" }), json({ ok: true }));
    const pending = hcpHttp(fetch).request("/things");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("is ignored for providers that do not document it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { fetch, calls } = mockFetch(text("", 429, { "ratelimit-reset": epoch(30) }), json({ ok: true }));
    const pending = client(fetch).request("/things");
    await vi.advanceTimersByTimeAsync(1_000); // the 1 s fallback backoff, not 30 s
    await expect(pending).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("reports the reset as retryAfterMs when it is longer than maxRetryDelayMs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { fetch, calls } = mockFetch(text("", 429, { "ratelimit-reset": epoch(120) }));
    const error = await hcpHttp(fetch, { maxRetryDelayMs: 60_000 }).request("/things").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CrmRateLimitError);
    expect((error as CrmRateLimitError).retryAfterMs).toBe(120_000);
    expect(calls).toHaveLength(1);
  });

  it("measures the reset against the server's Date header, so a slow local clock doesn't stretch the wait", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now); // the local clock runs 90 s behind the server
    const serverNow = new Date(now + 90_000).toUTCString();
    const { fetch, calls } = mockFetch(text("", 429, { "ratelimit-reset": epoch(95), date: serverNow }), json({ ok: true }));
    const pending = hcpHttp(fetch).request("/things");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("falls back to the local clock when the Date header is unreadable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { fetch } = mockFetch(text("", 429, { "ratelimit-reset": epoch(2), date: "yesterday" }), json({ ok: true }));
    const pending = hcpHttp(fetch).request("/things");
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("adds up to a second of jitter, so clients sharing a key spread their retries", async () => {
    vi.mocked(Math.random).mockReturnValue(0.75);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { fetch, calls } = mockFetch(text("", 429, { "ratelimit-reset": epoch(2) }), json({ ok: true }));
    const pending = hcpHttp(fetch).request("/things");
    await vi.advanceTimersByTimeAsync(2_749);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("treats a 503 with RateLimit-Reset as a rate limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { fetch } = mockFetch(text("", 503, { "ratelimit-reset": epoch(3) }), json({ ok: true }));
    const pending = hcpHttp(fetch).request("/things");
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toEqual({ ok: true });
  });
});

describe("parseRateLimitReset", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");

  it("reads Unix seconds and Unix milliseconds as the reset moment", () => {
    expect(parseRateLimitReset(String(now / 1000 + 7), now)).toBe(7_000);
    expect(parseRateLimitReset(String(now + 1_500), now)).toBe(1_500);
    expect(parseRateLimitReset(` ${now / 1000 + 2.5} `, now)).toBe(2_500);
  });

  it("never returns a negative wait for a moment already passed", () => {
    expect(parseRateLimitReset(String(now / 1000 - 60), now)).toBe(0);
    expect(parseRateLimitReset(String(now - 60_000), now)).toBe(0);
  });

  it("reads a small number as seconds from now", () => {
    expect(parseRateLimitReset("30", now)).toBe(30_000);
    expect(parseRateLimitReset("0", now)).toBe(0);
  });

  it("ignores missing, unreadable or out-of-range values", () => {
    expect(parseRateLimitReset(null, now)).toBeUndefined();
    expect(parseRateLimitReset("", now)).toBeUndefined();
    expect(parseRateLimitReset("-5", now)).toBeUndefined();
    expect(parseRateLimitReset("Thu, 01 Jan 2026 00:00:10 GMT", now)).toBeUndefined();
    expect(parseRateLimitReset("50000000000", now)).toBeUndefined();
    expect(parseRateLimitReset("99999999999999", now)).toBeUndefined();
  });
});

describe("parseRetryAfter date formats", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("reads IMF-fixdate, RFC 850 and asctime as GMT, whatever the server's zone", () => {
    process.env.TZ = "Asia/Tokyo";
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", now)).toBe(10_000);
    expect(parseRetryAfter("Thursday, 01-Jan-26 00:00:10 GMT", now)).toBe(10_000);
    expect(parseRetryAfter("Thu Jan  1 00:00:10 2026", now)).toBe(10_000);
  });
});
