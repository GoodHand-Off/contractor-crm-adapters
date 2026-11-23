declare global {
  /**
   * Lets the public types name `AbortSignal` without the DOM lib or
   * `@types/node`. Where either is present this merges with the real type.
   */
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- intentionally empty; see above
  interface AbortSignal {}
}

/** The init object the client passes to `fetch`. */
export interface FetchInit {
  /** "GET" or "POST". */
  method: string;
  /** Request headers, including `Authorization`. */
  headers: Record<string, string>;
  /** JSON request body, for writes. */
  body?: string;
  /** Aborts the request on timeout or caller cancellation. Honour it. */
  signal: AbortSignal;
}

/** The parts of a fetch `Response` the client reads. */
export interface FetchResponse {
  /** `true` for a 2xx status. */
  ok: boolean;
  /** HTTP status code. */
  status: number;
  /** Response headers; the client reads `Retry-After`, and `RateLimit-Reset` and `Date` for Housecall Pro. */
  headers: { get(name: string): string | null };
  /** The response body as text. */
  text(): Promise<string>;
}

/**
 * Any fetch-compatible function: `globalThis.fetch`, undici's `fetch`, or a
 * test double. Declared here so consumers need neither the DOM lib nor
 * `@types/node`.
 */
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;
