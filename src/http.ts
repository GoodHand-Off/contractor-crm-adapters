import {
  CrmAuthError,
  CrmHttpError,
  CrmNetworkError,
  CrmNotFoundError,
  CrmRateLimitError,
  CrmResponseError,
  CrmTimeoutError,
  type CrmHttpErrorInit,
} from "./errors.js";
import type { FetchInit, FetchLike } from "./fetch.js";
import { Gate, gateOf, type RequestLimiter } from "./limiter.js";
import { PROVIDER_INFO } from "./provider-info.js";
import type { CrmProviderName } from "./types.js";
import { invalid, numberOption, optionalString } from "./validate.js";

/** Options shared by every client. Only `apiKey` is required. */
export interface ClientOptions {
  /**
   * The CRM API key. Sent only in the `Authorization` header to `baseUrl`, in
   * the form each vendor documents (`Bearer <key>` for JobNimbus and AccuLynx,
   * `Token <key>` for Housecall Pro). It is kept in an ES private field, so it
   * never appears in logs, `util.inspect` or `JSON.stringify` of a client, and
   * never in an error message.
   */
  apiKey: string;
  /** Any fetch-compatible function. Default: `globalThis.fetch`. */
  fetch?: FetchLike | undefined;
  /**
   * Override the API base URL, for a proxy or a mock server. Must be `https:`,
   * except for `localhost`, `127.0.0.1` and `[::1]`, and must not carry a
   * query string or fragment.
   */
  baseUrl?: string | undefined;
  /** Per-attempt timeout covering headers and body, in ms: 1 to 2,147,483,647. Default 30,000. */
  timeoutMs?: number | undefined;
  /**
   * How many times to retry a request the server rate limited (HTTP 429, or
   * 503 that says when to come back). A whole number from 0 to 10; default 2.
   * Other failures are never retried.
   */
  maxRetries?: number | undefined;
  /**
   * The longest pause the client will wait out. If the server asks for longer,
   * the client throws {@link CrmRateLimitError} at once with `retryAfterMs`
   * set, so you can schedule the work yourself. 0 to 2,147,483,647 ms;
   * default 60,000.
   */
  maxRetryDelayMs?: number | undefined;
  /**
   * Minimum gap between the start of two requests from this client, in ms
   * (0 to 2,147,483,647). Requests are spaced, not dropped. Defaults to the provider's documented
   * per-key limit (AccuLynx: 100 ms, i.e. 10 requests per second; JobNimbus
   * and Housecall Pro: 0, since neither documents a number).
   */
  minRequestIntervalMs?: number | undefined;
  /**
   * A budget shared with other clients, for limits wider than one key (such
   * as AccuLynx's 30 requests per second per IP). See {@link RequestLimiter}.
   */
  limiter?: RequestLimiter | undefined;
  /** Sent as the `User-Agent` header where the runtime allows it. */
  userAgent?: string | undefined;
  /**
   * The client refuses to run in a web page, because every request carries
   * the API key. Set this only if the key belongs to the person using the page.
   * Default `false`.
   */
  dangerouslyAllowBrowser?: boolean | undefined;
}

/** Per-call options accepted by every client method. */
export interface CallOptions {
  /** Cancel the request, and any pending retry or spacing wait. Rejects with the signal's reason. */
  signal?: AbortSignal | undefined;
}

type QueryValue = string | number | boolean | undefined;

/** What an adapter tells the HTTP layer about its vendor. Internal. */
export interface ProviderDefaults {
  /** The documented API base URL. */
  baseUrl: string;
  /** Default spacing between request starts, in ms. */
  minRequestIntervalMs: number;
  /** The word before the key in the `Authorization` header. Default `"Bearer"`. */
  authScheme?: "Bearer" | "Token";
  /** Read the wait after a 429 from `RateLimit-Reset` before `Retry-After`. Default `false`. */
  rateLimitReset?: boolean;
}

interface HttpRequest {
  method?: "GET" | "POST";
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRIES_LIMIT = 10;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const FALLBACK_BACKOFF_MS = 1_000;
const BODY_LIMIT = 2_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** The longest delay setTimeout supports (about 24.8 days); larger values would fire after 1 ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1;
/** Visible ASCII only: anything else cannot travel in an HTTP header. */
const HEADER_SAFE = /^[\x21-\x7E]+$/;

/**
 * The HTTP layer under every client: request spacing, a client-wide pause
 * after a 429, bounded retries and typed errors. Internal. All state is in ES
 * private fields, so the key cannot leak through logging or serialization.
 */
export class HttpClient {
  readonly #provider: CrmProviderName;
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #maxRetryDelayMs: number;
  readonly #userAgent: string | undefined;
  readonly #gates: Gate[];
  readonly #authScheme: "Bearer" | "Token";
  readonly #rateLimitReset: boolean;

  constructor(provider: CrmProviderName, defaults: ProviderDefaults, options: ClientOptions) {
    if (typeof options !== "object" || options === null) invalid(provider, "options must be an object with an apiKey");
    this.#provider = provider;
    this.#authScheme = defaults.authScheme ?? "Bearer";
    this.#rateLimitReset = defaults.rateLimitReset === true;
    this.#apiKey = checkApiKey(provider, options.apiKey);
    this.#baseUrl = checkBaseUrl(provider, options.baseUrl ?? defaults.baseUrl);
    const fetchImpl: unknown = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      invalid(provider, "no global fetch in this runtime; pass the fetch option (Node 18+ has one built in)");
    }
    this.#fetch = fetchImpl as FetchLike;
    if (options.dangerouslyAllowBrowser !== true && isBrowser()) {
      invalid(
        provider,
        "refusing to run in a browser, because every request carries the API key. Call the CRM from your server, " +
          "or set dangerouslyAllowBrowser: true only if the key belongs to the person using the page.",
      );
    }
    this.#timeoutMs = numberOption(provider, options.timeoutMs, "timeoutMs", {
      fallback: DEFAULT_TIMEOUT_MS,
      min: 1,
      max: MAX_TIMER_MS,
    });
    this.#maxRetries = numberOption(provider, options.maxRetries, "maxRetries", {
      fallback: DEFAULT_MAX_RETRIES,
      min: 0,
      max: MAX_RETRIES_LIMIT,
      integer: true,
    });
    this.#maxRetryDelayMs = numberOption(provider, options.maxRetryDelayMs, "maxRetryDelayMs", {
      fallback: DEFAULT_MAX_RETRY_DELAY_MS,
      min: 0,
      max: MAX_TIMER_MS,
    });
    const minInterval = numberOption(provider, options.minRequestIntervalMs, "minRequestIntervalMs", {
      fallback: defaults.minRequestIntervalMs,
      min: 0,
      max: MAX_TIMER_MS,
    });
    this.#gates = [new Gate(minInterval)];
    if (options.limiter !== undefined) this.#gates.push(gateOf(provider, options.limiter));
    this.#userAgent = optionalString(provider, options.userAgent, "userAgent");
    if (this.#userAgent !== undefined && !/^[\x20-\x7E]+$/.test(this.#userAgent)) {
      invalid(provider, "userAgent must be a single line of printable ASCII");
    }
  }

  /** Send one request and parse the JSON body. Returns `undefined` for an empty body. */
  async request<T>(path: string, init: HttpRequest = {}): Promise<T | undefined> {
    const method = init.method ?? "GET";
    const url = this.#buildUrl(path, init.query);
    const headers: Record<string, string> = {
      Authorization: `${this.#authScheme} ${this.#apiKey}`,
      Accept: "application/json",
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (this.#userAgent) headers["User-Agent"] = this.#userAgent;
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);

    for (let attempt = 0; ; attempt++) {
      await this.#waitForSlot(method, path, init.signal);
      const response = await this.#send(url, { method, headers, body }, path, init.signal);
      if (response.ok) return this.#parseBody<T>(response.text, method, path);

      const errorInit: CrmHttpErrorInit = { status: response.status, method, path };
      if (response.text) errorInit.responseBody = response.text.slice(0, BODY_LIMIT);
      const retryAfterMs = this.#serverWait(response);
      const rateLimited = response.status === 429 || (response.status === 503 && retryAfterMs !== undefined);

      if (rateLimited) {
        const waitMs = retryAfterMs ?? FALLBACK_BACKOFF_MS * 2 ** attempt;
        // Pause every request through this client (and any shared limiter), not just this one.
        const until = Date.now() + waitMs;
        for (const gate of this.#gates) gate.pausedUntil = Math.max(gate.pausedUntil, until);
        if (attempt >= this.#maxRetries || waitMs > this.#maxRetryDelayMs) {
          throw new CrmRateLimitError(this.#provider, {
            ...errorInit,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          });
        }
        continue; // #waitForSlot waits out the pause before the retry
      }
      if (response.status === 401 || response.status === 403) throw new CrmAuthError(this.#provider, errorInit);
      if (response.status === 404) throw new CrmNotFoundError(this.#provider, errorInit);
      throw new CrmHttpError(this.#provider, errorInit);
    }
  }

  /**
   * How long the server asked us to wait, in ms, or `undefined` if it did not
   * say. Providers that document `RateLimit-Reset` (Housecall Pro) are read
   * from it first. A reset time that has already passed, as a clock running
   * ahead of the server's would make it, counts as unsaid, so the retry backs
   * off instead of firing at once.
   */
  #serverWait(response: { retryAfter: string | null; rateLimitReset: string | null }): number | undefined {
    if (this.#rateLimitReset) {
      const resetMs = parseRateLimitReset(response.rateLimitReset);
      if (resetMs !== undefined && resetMs > 0) return resetMs;
    }
    return parseRetryAfter(response.retryAfter);
  }

  /**
   * Wait for this client's spacing, any shared limiter's spacing, and any
   * pause a 429 or 503 set. Slots are reserved synchronously, so concurrent
   * calls queue in order, and the pause is re-checked after every wait, so a
   * pause that starts while a call is queued holds that call too. A pause
   * longer than `maxRetryDelayMs` throws at once.
   */
  async #waitForSlot(method: string, path: string, signal: AbortSignal | undefined): Promise<void> {
    for (;;) {
      const now = Date.now();
      const pausedUntil = Math.max(...this.#gates.map((gate) => gate.pausedUntil));
      if (pausedUntil - now > this.#maxRetryDelayMs) {
        throw new CrmRateLimitError(this.#provider, { status: 429, method, path, retryAfterMs: pausedUntil - now });
      }
      if (pausedUntil > now) {
        await sleep(pausedUntil - now, signal);
        continue;
      }
      const slot = Math.max(now, ...this.#gates.map((gate) => gate.nextSlotAt));
      for (const gate of this.#gates) gate.nextSlotAt = slot + gate.minIntervalMs;
      if (slot === now) return;
      await sleep(slot - now, signal);
      if (Math.max(...this.#gates.map((gate) => gate.pausedUntil)) <= Date.now()) return;
    }
  }

  async #send(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string | undefined },
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<{ ok: boolean; status: number; retryAfter: string | null; rateLimitReset: string | null; text: string }> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const fetchInit: FetchInit = { method: init.method, headers: init.headers, signal: controller.signal };
    if (init.body !== undefined) fetchInit.body = init.body;
    try {
      // The timeout covers the whole attempt, headers and body, even if a custom fetch ignores the signal.
      const response = await abortable(this.#fetch(url, fetchInit), controller.signal);
      const text = await abortable(response.text(), controller.signal);
      return {
        ok: response.ok,
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        rateLimitReset: response.headers.get("ratelimit-reset"),
        text,
      };
    } catch (error) {
      if (timedOut) {
        throw new CrmTimeoutError(this.#provider, { timeoutMs: this.#timeoutMs, method: init.method, path });
      }
      if (signal?.aborted) throw signal.reason;
      throw new CrmNetworkError(this.#provider, { method: init.method, path, cause: error });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  #parseBody<T>(text: string, method: string, path: string): T | undefined {
    if (text.trim() === "") return undefined;
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new CrmResponseError(
        this.#provider,
        `${PROVIDER_INFO[this.#provider].displayName} API returned a body that is not JSON for ${method} ${path}.`,
        { cause: error },
      );
    }
  }

  #buildUrl(path: string, query: Record<string, QueryValue> | undefined): string {
    const url = new URL(this.#baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }
}

/**
 * Parse a `Retry-After` header value: delta-seconds, or an HTTP-date in any of
 * the three formats HTTP allows (IMF-fixdate, RFC 850, asctime).
 *
 * @param value - The raw header value, or `null` when absent.
 * @param now - The current time in Unix ms, for HTTP-dates. Default `Date.now()`.
 * @returns Milliseconds to wait (never negative), or `undefined` when the header is absent or unreadable.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  // HTTP-dates start with a day name ("Sun," / "Sunday," / "Sun "); this rejects "-5" and other numerics Date.parse accepts.
  if (!/^[A-Za-z]{3,9},? /.test(trimmed)) return undefined;
  // asctime ("Sun Nov  6 08:49:37 1994") has no zone but means GMT; say so, or Date.parse would use local time.
  const date = Date.parse(/^[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(trimmed) ? `${trimmed} GMT` : trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** Unix seconds from 2001-09-09 to 2286-11-20; Unix milliseconds over the same span. */
const EPOCH_SECONDS = [1e9, 1e10] as const;
const EPOCH_MILLIS = [1e12, 1e13] as const;

/**
 * Parse a `RateLimit-Reset` header. Housecall Pro documents it on a 429 as
 * "the time (in epoch format) that the user rate limit will be reset".
 *
 * - Unix seconds (1e9 to 1e10) or Unix milliseconds (1e12 to 1e13) are read as that moment.
 * - A smaller number is read as seconds from now, the meaning IETF drafts of
 *   the RateLimit headers gave it, so either form is waited out.
 *
 * @param value - The raw header value, or `null` when absent.
 * @param now - The current time in Unix ms. Default `Date.now()`.
 * @returns Milliseconds to wait (never negative), or `undefined` when the header is absent or unreadable.
 */
export function parseRateLimitReset(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined;
  const number = Number(trimmed);
  if (number < EPOCH_SECONDS[0]) return Math.round(number * 1000);
  if (number < EPOCH_SECONDS[1]) return Math.max(0, Math.round(number * 1000) - now);
  if (number >= EPOCH_MILLIS[0] && number < EPOCH_MILLIS[1]) return Math.max(0, Math.round(number) - now);
  return undefined;
}

function checkApiKey(provider: CrmProviderName, apiKey: unknown): string {
  const help = PROVIDER_INFO[provider].keyHelp;
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    invalid(provider, `apiKey is missing or empty. ${help}`);
  }
  const key = apiKey.trim();
  if (!HEADER_SAFE.test(key)) {
    // Never echo the key: it may be real.
    invalid(provider, `apiKey contains spaces, line breaks or non-ASCII characters, so it was probably pasted wrong. ${help}`);
  }
  return key;
}

function checkBaseUrl(provider: CrmProviderName, value: unknown): string {
  // URL drops an empty "?" or "#", so check the raw string: either would break every request path.
  if (typeof value === "string" && /[?#]/.test(value)) invalid(provider, "baseUrl must not contain a query string or fragment");
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    return invalid(provider, "baseUrl must be an absolute URL, e.g. https://proxy.example.com/crm");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    invalid(provider, "baseUrl must use https (plain http is allowed only for localhost), so the key is never sent in clear text");
  }
  if (url.search || url.hash) invalid(provider, "baseUrl must not contain a query string or fragment");
  if (url.username || url.password) invalid(provider, "baseUrl must not contain credentials");
  return url.toString().replace(/\/+$/, "");
}

function isBrowser(): boolean {
  const g = globalThis as { window?: unknown; document?: unknown };
  return typeof g.window !== "undefined" && typeof g.document !== "undefined";
}

/** Settle with `promise`, or reject with the signal's reason as soon as it aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Wait `ms`, in chunks of at most {@link MAX_TIMER_MS}, so a long wait never overflows setTimeout. */
async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  for (let left = ms; left > 0; left -= MAX_TIMER_MS) await sleepChunk(Math.min(left, MAX_TIMER_MS), signal);
}

function sleepChunk(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
