import { vi } from "vitest";

/** A key-shaped string that is obviously not real. */
export const TEST_API_KEY = "test-key";

export interface RecordedCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = Response | ((call: RecordedCall, signal: AbortSignal | undefined) => Response | Promise<Response>);

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function text(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

/**
 * A fetch mock that answers with the queued replies in order and records each
 * call. Throws if the code under test makes more calls than were queued.
 */
export function mockFetch(...replies: Reply[]) {
  const calls: RecordedCall[] = [];
  const queue = [...replies];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    const call: RecordedCall = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers,
      body: rawBody === undefined ? undefined : JSON.parse(rawBody),
    };
    calls.push(call);
    const reply = queue.shift();
    if (!reply) throw new Error(`unexpected request #${calls.length}: ${call.method} ${call.url}`);
    return typeof reply === "function" ? reply(call, init?.signal ?? undefined) : reply;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, mock: fetch };
}

/** A fetch reply that never settles until the request is aborted. */
export function hang(): Reply {
  return (_call, signal) =>
    new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
}

export function filterOf(call: RecordedCall | undefined): unknown {
  const raw = call?.url.searchParams.get("filter") ?? null;
  return raw === null ? undefined : JSON.parse(raw);
}

/** A 200 whose body never finishes until the request is aborted, even though it ignores the signal itself. */
export function stalledBody(): Reply {
  return () =>
    ({
      ok: true,
      status: 200,
      headers: new Headers(),
      // Never resolves: proves the client's own timeout covers the body read.
      text: () => new Promise<string>(() => {}),
    }) as unknown as Response;
}

/** A JSON reply produced lazily, so a test can build it when the request arrives. */
export function jsonLater(body: () => unknown): Reply {
  return () => json(body());
}
