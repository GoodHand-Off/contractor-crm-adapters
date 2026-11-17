# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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
