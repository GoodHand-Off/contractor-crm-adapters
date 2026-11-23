# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-11-23

### Added

- Housecall Pro adapter (`HousecallProClient`, provider name `"housecallpro"`):
  connection test, paginated customer listing, customer creation, job creation
  for a customer (finding or adding the customer's address), and notes on jobs.
  It sends `Authorization: Token <key>`. It follows Housecall Pro's public API
  docs as read on 2026-11-23 and has not been run against a live account.
- `RateLimit-Reset` in the HTTP layer: after a Housecall Pro 429 the client
  waits until the reset time the header gives, then retries.
  `parseRateLimitReset` is exported next to `parseRetryAfter`.
- `JobNimbusContactPayload`, `JobNimbusJobPayload` and `HousecallProJobPayload`
  types.

### Changed (breaking)

0.x releases may break the API in a minor version. Each change below is a
compile-time change only; nothing that worked at runtime stops working.

- `CrmContactPayload.recordTypeName` and `statusName`, and
  `CrmJobPayload.name`, `recordTypeName` and `statusName`, are now optional,
  because Housecall Pro has no such fields. JobNimbus still needs them:
  `JobNimbusClient.createContact` and `createJob` now take
  `JobNimbusContactPayload` and `JobNimbusJobPayload`, which keep them
  required at compile time, and a call through `CrmClient` without them still
  throws `CrmValidationError` naming the field. Code that reads these fields
  from a `CrmContactPayload` or `CrmJobPayload` now gets `string | undefined`.
- `CrmProviderName` gains `"housecallpro"`, so an exhaustive `switch` over it
  needs a new case, and an object typed `Record<CrmProviderName, ...>` needs a
  `housecallpro` key.
- A value typed `CrmContactPayload` or `CrmJobPayload` no longer compiles as
  the argument of `JobNimbusClient.createContact` or `createJob`; type it
  `JobNimbusContactPayload` or `JobNimbusJobPayload`. A client from
  `createCrmClient("jobnimbus", ...)` is a `CrmClient`, so it no longer checks
  `recordTypeName` and `statusName` at compile time; use
  `new JobNimbusClient(...)` to keep that check. JobNimbus still rejects a
  missing one at runtime.

### Notes

- `CrmValidationError` can now follow a read: Housecall Pro's `createJob` reads
  the customer's addresses before choosing one, and throws without writing
  anything if the choice is ambiguous.
- Housecall Pro's `createJob` may add an address to the customer before
  creating the job. If the job then fails, the address stays; a retry reuses
  it.

## [0.1.0] - 2026-11-17

### Added

- JobNimbus adapter: connection test, paginated contact listing (past the
  10,000-record query window, deleted records skipped by default), contact,
  job and note creation, and recent notes for a record.
- AccuLynx adapter (read-only): connection test and paginated job listing,
  normalized to the shared contact shape.
- `listContacts` returns `{ contacts, truncated }`, so a read that stopped at
  `maxRecords` is visible.
- Shared HTTP layer with an injectable fetch (`FetchLike`, no DOM or Node
  types needed), per-attempt timeouts covering headers and body, a client-wide
  pause after a 429, bounded `Retry-After` retries and typed errors.
- `RequestLimiter` for a request budget shared by several clients.
- `createRepMatcher` (never guesses between candidates) and
  `collectAssignedReps` for mapping CRM sales reps to your own users.
- Input validation on every option and payload field, with
  `CrmValidationError` naming the field; missing keys point to where each
  vendor documents creating one. `CRM_PROVIDERS[provider].keyHelp` carries the
  same text for settings screens.
- The API key is held in an ES private field, never logged or serialized; the
  client refuses to run in a browser unless `dangerouslyAllowBrowser` is set,
  and rejects a non-HTTPS `baseUrl` other than localhost.
