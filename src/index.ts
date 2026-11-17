export { createCrmClient, isCrmProviderName, CRM_PROVIDERS } from "./registry.js";
export type { CrmProviderInfo } from "./registry.js";
export { JobNimbusClient } from "./providers/jobnimbus.js";
export { AccuLynxClient } from "./providers/acculynx.js";
export { createRepMatcher, collectAssignedReps } from "./match.js";
export type { RepCandidate } from "./match.js";
export { parseRetryAfter } from "./http.js";
export { RequestLimiter } from "./limiter.js";
export type { FetchLike, FetchInit, FetchResponse } from "./fetch.js";
export type { ClientOptions, CallOptions } from "./http.js";
export {
  CrmError,
  CrmHttpError,
  CrmAuthError,
  CrmNotFoundError,
  CrmRateLimitError,
  CrmTimeoutError,
  CrmNetworkError,
  CrmResponseError,
  CrmUnsupportedError,
  CrmValidationError,
} from "./errors.js";
export type { CrmHttpErrorInit } from "./errors.js";
export type {
  CrmProviderName,
  CrmAddress,
  CrmAssignedRep,
  CrmContact,
  ContactList,
  ContactListEnd,
  CrmJobContext,
  CustomFieldMappings,
  CrmNote,
  CrmContactPayload,
  CrmJobPayload,
  CrmCapabilities,
  CrmClient,
  ListContactsOptions,
  ListNotesOptions,
  CreateNoteOptions,
} from "./types.js";
