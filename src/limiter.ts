import type { CrmProviderName } from "./types.js";
import { invalid } from "./validate.js";

/** Request spacing and server-requested pause state. Internal. */
export class Gate {
  /** Minimum gap between request starts, in ms. */
  readonly minIntervalMs: number;
  /** Earliest time the next request may start (Unix ms). */
  nextSlotAt = 0;
  /** No request may start before this time (Unix ms), after a 429 or 503. */
  pausedUntil = 0;

  constructor(minIntervalMs: number) {
    this.minIntervalMs = minIntervalMs;
  }
}

const gates = new WeakMap<RequestLimiter, Gate>();

/**
 * A request budget shared by several clients. Use one when many clients run
 * in the same process against a limit that is wider than one key, such as
 * AccuLynx's 30 requests per second per IP address.
 *
 * Each client still keeps its own per-key spacing; the limiter adds a second,
 * shared gate. A 429 or 503 seen by any client pauses every client that
 * shares the limiter until the server's `Retry-After` has passed.
 *
 * @example
 * ```ts
 * const perIp = new RequestLimiter({ minIntervalMs: 40 }); // 25 requests per second in total
 * const clients = keys.map((apiKey) => new AccuLynxClient({ apiKey, limiter: perIp }));
 * ```
 */
export class RequestLimiter {
  /** Minimum gap between the start of two requests from all clients sharing this limiter, in ms. */
  readonly minIntervalMs: number;

  /**
   * Create a shared limiter.
   *
   * @param options - `minIntervalMs`: the minimum gap between request starts across all sharing clients.
   * @throws TypeError if `minIntervalMs` is not a number from 0 to 2,147,483,647.
   */
  constructor(options: { minIntervalMs: number }) {
    const value: unknown = options?.minIntervalMs;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2 ** 31 - 1) {
      throw new TypeError("RequestLimiter: minIntervalMs must be a number from 0 to 2147483647");
    }
    this.minIntervalMs = value;
    gates.set(this, new Gate(value));
  }
}

/** The gate behind a shared limiter, or a validation error for anything else. Internal. */
export function gateOf(provider: CrmProviderName, limiter: unknown): Gate {
  const gate = limiter instanceof RequestLimiter ? gates.get(limiter) : undefined;
  if (!gate) invalid(provider, "limiter must be a RequestLimiter created with new RequestLimiter(...)");
  return gate;
}
