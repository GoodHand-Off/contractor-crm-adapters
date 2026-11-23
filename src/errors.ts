import { PROVIDER_INFO } from "./provider-info.js";
import type { CrmProviderName } from "./types.js";

/**
 * Base class for every error this library throws on purpose. Catch it to
 * handle any CRM failure; check `instanceof` a subclass to act on one kind.
 *
 * Messages never contain the API key or the response body. The body of a
 * failed HTTP response is kept on {@link CrmHttpError.responseBody} so you can
 * log it deliberately, after deciding it holds nothing sensitive.
 */
export class CrmError extends Error {
  /** The adapter that threw. */
  readonly provider: CrmProviderName;

  /**
   * Create an error attributed to one adapter.
   *
   * @param provider - The adapter that threw.
   * @param message - Human-readable description, already naming the provider.
   * @param options - Optional `cause` (the underlying error).
   */
  constructor(provider: CrmProviderName, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.provider = provider;
  }
}

/** Fields shared by every HTTP error. */
export interface CrmHttpErrorInit {
  /** HTTP status code. */
  status: number;
  /** HTTP method. */
  method: string;
  /** Request path without the base URL or query string. */
  path: string;
  /** Start of the response body, if any. */
  responseBody?: string;
}

/**
 * The CRM answered with a non-2xx status that has no more specific class.
 * Also the base class of {@link CrmAuthError}, {@link CrmNotFoundError} and
 * {@link CrmRateLimitError}.
 */
export class CrmHttpError extends CrmError {
  /** HTTP status code. */
  readonly status: number;
  /** HTTP method, e.g. "GET". */
  readonly method: string;
  /** Request path without the base URL or query string, e.g. "/contacts". */
  readonly path: string;
  /** First 2,000 characters of the response body, if any. Not part of `message`. */
  readonly responseBody: string | undefined;

  /**
   * Create an error for a failed HTTP response.
   *
   * @param provider - The adapter that threw.
   * @param init - Status, method, path and optional body of the failed response.
   * @param message - Overrides the default message.
   */
  constructor(provider: CrmProviderName, init: CrmHttpErrorInit, message?: string) {
    super(
      provider,
      message ??
        `${display(provider)} API returned HTTP ${init.status} for ${init.method} ${init.path}.` +
          (init.responseBody ? " The response body is on error.responseBody." : ""),
    );
    this.status = init.status;
    this.method = init.method;
    this.path = init.path;
    this.responseBody = init.responseBody;
  }
}

/** HTTP 401 or 403: the key is missing, wrong, revoked or lacks permission. */
export class CrmAuthError extends CrmHttpError {
  /**
   * Create the error from the failed response.
   *
   * @param provider - The adapter that threw.
   * @param init - Status, method, path and optional body of the failed response.
   */
  constructor(provider: CrmProviderName, init: CrmHttpErrorInit) {
    super(
      provider,
      init,
      `${display(provider)} API returned HTTP ${init.status} for ${init.method} ${init.path}: ` +
        `the API key is invalid, revoked or lacks permission. ${PROVIDER_INFO[provider].keyHelp}`,
    );
  }
}

/** HTTP 404: the record or route does not exist. */
export class CrmNotFoundError extends CrmHttpError {
  /**
   * Create the error from the failed response.
   *
   * @param provider - The adapter that threw.
   * @param init - Status, method, path and optional body of the failed response.
   */
  constructor(provider: CrmProviderName, init: CrmHttpErrorInit) {
    super(
      provider,
      init,
      `${display(provider)} API returned HTTP 404 for ${init.method} ${init.path}: the record does not exist or the key cannot see it.`,
    );
  }
}

/**
 * HTTP 429 (or a 503 that says when to come back) after the client stopped retrying.
 * Schedule the work again after {@link CrmRateLimitError.retryAfterMs}.
 */
export class CrmRateLimitError extends CrmHttpError {
  /** How long the server asked callers to wait, in milliseconds, when it said. */
  readonly retryAfterMs: number | undefined;

  /**
   * Create a rate-limit error.
   *
   * @param provider - The adapter that threw.
   * @param init - Status, method, path, optional body and the server's requested wait.
   */
  constructor(provider: CrmProviderName, init: CrmHttpErrorInit & { retryAfterMs?: number }) {
    super(
      provider,
      init,
      `${display(provider)} API rate limited ${init.method} ${init.path} (HTTP ${init.status}); ` +
        (init.retryAfterMs !== undefined
          ? `retry after ${Math.ceil(init.retryAfterMs / 1000)} s.`
          : "wait before retrying."),
    );
    this.retryAfterMs = init.retryAfterMs;
  }
}

/** The request did not finish within `timeoutMs`. Not retried automatically. */
export class CrmTimeoutError extends CrmError {
  /** The timeout that elapsed, in milliseconds. */
  readonly timeoutMs: number;
  /** HTTP method of the request. */
  readonly method: string;
  /** Request path without the base URL or query string. */
  readonly path: string;

  /**
   * Create a timeout error.
   *
   * @param provider - The adapter that threw.
   * @param init - The timeout and the request that hit it.
   */
  constructor(provider: CrmProviderName, init: { timeoutMs: number; method: string; path: string }) {
    super(
      provider,
      `${display(provider)} API did not answer ${init.method} ${init.path} within ${init.timeoutMs} ms. ` +
        "Retry later, or raise the timeoutMs option.",
    );
    this.timeoutMs = init.timeoutMs;
    this.method = init.method;
    this.path = init.path;
  }
}

/** `fetch` itself rejected (DNS, TLS, connection reset). The original error is `cause`. Not retried automatically. */
export class CrmNetworkError extends CrmError {
  /**
   * Create a network error.
   *
   * @param provider - The adapter that threw.
   * @param init - The request that failed and the error `fetch` threw.
   */
  constructor(provider: CrmProviderName, init: { method: string; path: string; cause: unknown }) {
    super(
      provider,
      `Could not reach the ${display(provider)} API for ${init.method} ${init.path}. ` +
        "Check network access and the baseUrl option; the original error is error.cause.",
      { cause: init.cause },
    );
  }
}

/** A 2xx response whose body was not the JSON shape the client expects. */
export class CrmResponseError extends CrmError {}

/** The operation is not available for this provider (for example a write on AccuLynx). Check `client.capabilities` first. */
export class CrmUnsupportedError extends CrmError {
  /** The method that was called, e.g. "createNote". */
  readonly operation: string;

  /**
   * Create an unsupported-operation error.
   *
   * @param provider - The adapter that threw.
   * @param operation - The method that was called.
   */
  constructor(provider: CrmProviderName, operation: string) {
    super(
      provider,
      `${operation} is not supported by the ${display(provider)} adapter; check client.capabilities before calling it.`,
    );
    this.operation = operation;
  }
}

/**
 * The input was rejected before anything was written. The message names the
 * field. Usually no request was sent at all; Housecall Pro's `createJob` may
 * first read the customer's addresses to find the one to use.
 */
export class CrmValidationError extends CrmError {}

function display(provider: CrmProviderName): string {
  return PROVIDER_INFO[provider].displayName;
}
