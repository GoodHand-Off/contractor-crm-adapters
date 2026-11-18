# contractor-crm-adapters: JobNimbus API and AccuLynx API clients

Typed Node.js and TypeScript clients for the **JobNimbus API** and the
**AccuLynx API**, two CRMs used by roofing and home-improvement contractors.
One normalized contact shape, an injectable `fetch`, timeouts, paging within
each vendor's documented limits, and typed errors. For developers and agencies
who build integrations for contractors.

There is no hosted demo; this is a library. Every test runs against a mocked
`fetch`, so `test/` shows exactly what goes over the wire.

## Quick start

In an empty folder (the package isn't on npm yet, so this installs it from
GitHub; its `prepare` script builds it):

```bash
npm install git+https://github.com/GoodHand-Off/contractor-crm-adapters.git
```

Save this as `quickstart.mjs`:

```js
import { CRM_PROVIDERS, createCrmClient } from "contractor-crm-adapters";

const apiKey = process.env.JOBNIMBUS_API_KEY;
if (!apiKey) {
  console.error(`Set JOBNIMBUS_API_KEY. ${CRM_PROVIDERS.jobnimbus.keyHelp}`);
  process.exit(1);
}

const crm = createCrmClient("jobnimbus", { apiKey });
await crm.testConnection(); // a wrong key throws CrmAuthError, saying where to create one

for await (const contact of crm.iterateContacts({ maxRecords: 10 })) {
  console.log(contact.externalId, contact.name ?? "(no name)", contact.status ?? "");
}
```

Then run it with your key:

```bash
JOBNIMBUS_API_KEY=your-key node quickstart.mjs
```

It prints up to ten contacts as `id name status`, oldest first. Without the
variable it stops with:

```text
Set JOBNIMBUS_API_KEY. Create a key in JobNimbus under Settings > API > New API key (https://documenter.getpostman.com/view/3919598/S11PpG4x).
```

Tested on Node 22 and 24, the supported LTS lines. `engines` also allows Node
20.19 and later, and the tests pass on 20.20, but Node 20 reached end of life
on 2026-04-30. The package is ESM with TypeScript types included, and
`require()` works too on Node versions that can load ES modules that way
(20.19+, 22.12+, 24). The types need neither the DOM lib nor `@types/node`.

**Run it on a server, never in a web page.** Every request carries the
contractor's API key. The client refuses to start in a browser unless you pass
`dangerouslyAllowBrowser: true`. The key is kept in an ES private field, so
logging or serializing a client never shows it.

## What you can do with each API

| | JobNimbus | AccuLynx |
| --- | --- | --- |
| `testConnection()` | `GET /contacts?size=1` | `GET /company-settings` |
| `iterateContacts()` / `listContacts()` | `GET /contacts`, all pages, deleted records skipped | `GET /jobs?includes=contact`, all pages, one record per job |
| `createContact()` | `POST /contacts` | not supported (read-only) |
| `createJob()` | `POST /jobs`, linked to a contact | not supported (read-only) |
| `createNote()` | `POST /activities` as a "Note" | not supported (read-only) |
| `listNotes()` | `GET /activities` filtered on `related.id` | not supported (no documented read endpoint) |

`client.capabilities` tells you which methods a client supports. Calling an
unsupported method rejects with `CrmUnsupportedError` and sends nothing.

### Push a canvassing lead into JobNimbus

```ts
import { JobNimbusClient } from "contractor-crm-adapters";

const jn = new JobNimbusClient({ apiKey });

const { externalId } = await jn.createContact({
  firstName: "Pat",
  lastName: "Example",
  phone: "555-555-0102",
  recordTypeName: "Customer", // must match a workflow in the account
  statusName: "Lead",         // must match a status in that workflow
  sourceName: "Door Knock",
  address: { street: "1 Fixture Row", city: "Testville", state: "ZZ", zip: "00000" },
  tags: ["storm", "canvassing"],
  assignedRepExternalId: repJnid,
  skipAutomation: true,       // JobNimbus ?skip=automation
});

await jn.createJob({ name: "Example roof", recordTypeName: "Job", statusName: "Lead", primaryContactExternalId: externalId });
await jn.createNote(externalId, "Homeowner asked for a Saturday inspection.", { source: "Your App" });
```

Inputs are checked before anything is sent. A missing `statusName`, a tag with
a comma, or a number where a string belongs throws `CrmValidationError` naming
the field.

### Read a whole account

```ts
const { contacts, truncated } = await crm.listContacts({ maxRecords: 20_000 });
if (truncated) console.warn(`Stopped at ${contacts.length} records; the account has more.`);
```

`listContacts` reads up to `maxRecords` (default 50,000) and tells you when it
stopped early. `iterateContacts` streams the same records one page at a time
and returns the same `truncated` flag as the generator's result.

### Map CRM sales reps to your own users

```ts
import { collectAssignedReps, createRepMatcher } from "contractor-crm-adapters";

const { contacts } = await crm.listContacts();
const match = createRepMatcher(team.map((u) => ({ id: u.id, name: u.fullName, email: u.email })));

for (const rep of collectAssignedReps(contacts)) {
  console.log(rep.name ?? rep.externalId, "->", match(rep.name) ?? "unmatched");
}
```

The matcher never guesses. In order, it tries:

1. If the CRM name contains "@", your users' emails only.
2. If the CRM name is one word ("Jordan"), your users' first names only. A
   one-word user name counts as a first name, so "Kim" matches nobody when you
   have both "Kim" and "Kim Ode".
3. The exact full name. "Avery, Jordan" is read as "Jordan Avery".
4. A two-word name reversed ("Avery Jordan").

It ignores case, accents and extra spaces. A name, first name or email that two
of your users share matches nobody, so you can review those by hand.

### Pull custom fields into the normalized record

JobNimbus returns custom fields as top-level keys on a contact, named by their
label ("Date of Loss") or, for older fields, a system name such as
`cf_string_1`. Date fields come as Unix seconds. Tell the client which field
holds what:

```ts
const { contacts } = await jn.listContacts({
  customFieldMappings: { insuranceContext: "Insurance Carrier", estimateValue: "Estimate Total", appointmentDate: "cf_date_1" },
});
console.log(contacts[0]?.jobContext?.estimateValue); // 12500, parsed from "$12,500.00"
```

Names match regardless of case, spaces, underscores or hyphens. A key that is
not a `jobContext` field (a typo such as `estimatedValue`) is rejected with the
list of valid keys.

### Choose the provider at runtime

```ts
import { createCrmClient, isCrmProviderName, CRM_PROVIDERS } from "contractor-crm-adapters";

if (!isCrmProviderName(saved.provider)) throw new Error("unsupported CRM");
const crm = createCrmClient(saved.provider, { apiKey: saved.apiKey });
console.log(CRM_PROVIDERS[saved.provider].keyHelp); // where the user creates a key, for your settings screen
```

## How it works

**One shape.** Every adapter returns `CrmContact`: an ID, name, email, phone,
address, `assignedReps` (`{ externalId, name? }`, primary first), tags, status,
and a `jobContext` with project type, milestone, lead source, dates (Unix ms)
and values. AccuLynx is job-centric, so its adapter returns one `CrmContact` per
job, keyed by job ID, with the job's primary contact as the person. Email and
phone come back as the CRM stores them, trimmed only. Phone formats vary by
account and country, so normalizing them is left to you.

**Deleted and archived records.** JobNimbus marks deleted records
`is_active: false`. Unless you pass `includeDeleted: true`, the client asks for
active records only and also drops any deleted record that comes back anyway.
Contacts and notes carry `deleted` and `archived` flags. This follows the
documented fields and filter syntax. It has not been checked against a live
account.

**Dates are read only when unambiguous.** Unix seconds or milliseconds in a
plausible range, ISO 8601 with an offset, or a date-only string (read as UTC).
A date-time without an offset would depend on the server's time zone, so it is
ignored rather than guessed.

**Bring your own `fetch`.** Pass any fetch-compatible function: undici, a
proxy-aware client, a recorder, or a mock in tests. Every method also takes an
`AbortSignal`.

```ts
import { JobNimbusClient } from "contractor-crm-adapters";

const client = new JobNimbusClient({ apiKey, fetch: myFetch, timeoutMs: 15_000, baseUrl: "https://proxy.example.com/jn" });
```

`baseUrl` must be `https:` (plain `http:` only for `localhost`), with no query
string, fragment or credentials, so the key never crosses the network in clear
text. Timing options (`timeoutMs`, `maxRetryDelayMs`, `minRequestIntervalMs`)
accept up to 2,147,483,647 ms, the most a JavaScript timer can hold.

**Paging.** JobNimbus pages with `size` and `from`, oldest first. A single
query cannot go past 10,000 records. The client then starts a new query
filtered on `date_created >= last seen` and drops the overlap, the method
JobNimbus describes in its
[guide to querying 10k+ contacts](https://support.jobnimbus.com/hubfs/Querying%2010k+%20contacts.pdf).
AccuLynx pages 25 jobs at a time (its documented maximum) with
`pageStartIndex`, and treats the documented HTTP 416 as the end. A 200
response without the expected list throws `CrmResponseError` rather than
reading as "no records".

**Rate limits, without retry storms.**

- AccuLynx clients space requests 100 ms apart by default, which is AccuLynx's
  documented 10 requests per second per key.
- On HTTP 429 (or 503 with `Retry-After`) the client pauses every request it
  is making, including ones already queued, for as long as the server asks.
  It then retries the rejected request, at most twice by default (`maxRetries`,
  0 to 10).
- If the server asks for a longer pause than `maxRetryDelayMs` (default 60 s),
  the client does not sleep. It throws `CrmRateLimitError` with `retryAfterMs`
  set, and keeps failing fast until the pause is over, so your job queue can
  schedule the retry.
- Timeouts, network failures and other 5xx responses are never retried
  automatically. Every attempt has a timeout covering headers and body
  (`timeoutMs`, default 30 s).

**Several clients, one budget.** Spacing is per client. To keep many clients in
one process under a shared limit, such as AccuLynx's 30 requests per second per
IP, give them one `RequestLimiter`. A 429 seen by any of them then pauses all
of them.

```ts
import { AccuLynxClient, RequestLimiter } from "contractor-crm-adapters";

const perIp = new RequestLimiter({ minIntervalMs: 40 }); // at most 25 requests per second in total
const clients = keys.map((apiKey) => new AccuLynxClient({ apiKey, limiter: perIp }));
```

**Typed errors.** Everything the library throws on purpose extends `CrmError`
and carries `provider`. Each message says what to do next.

| Error | When |
| --- | --- |
| `CrmValidationError` | bad input or options, before any request (for example a missing `statusName`, an empty `apiKey` or a NaN `maxRetries`) |
| `CrmAuthError` | HTTP 401 or 403; the message says where to create a key |
| `CrmNotFoundError` | HTTP 404 |
| `CrmRateLimitError` | 429 after retries, or a pause longer than you allow; has `retryAfterMs` |
| `CrmHttpError` | any other non-2xx (base class of the three above; has `status`, `method`, `path`) |
| `CrmTimeoutError` | no complete answer within `timeoutMs` |
| `CrmNetworkError` | `fetch` itself failed; the original error is `cause` |
| `CrmResponseError` | a 2xx whose body was not the JSON the client expects |
| `CrmUnsupportedError` | the provider does not support the operation |

Error messages never include the API key or the response body. The first 2,000
characters of a failed response are on `error.responseBody`, for you to log
deliberately. `createCrmClient` throws a plain `TypeError` for an unknown
provider name, and `new RequestLimiter` does for a bad `minIntervalMs`.

## Limits and costs

Checked against the vendors' public docs on 2026-11-17.

- The library is free (Apache-2.0). Every call runs against your contractor
  customer's own CRM account, using that account's key and limits.
- **AccuLynx** allows 30 requests per second per IP and 10 per second per API
  key ([rate limits](https://apidocs.acculynx.com/docs/rate-limits)). Writes are
  further capped at 6,000 per hour and 12,000 per day
  ([changelog](https://apidocs.acculynx.com/changelog/new-contact-endpoints-and-rate-limiting)).
  Reading an account with 20,000 jobs takes 800 requests, so at least 80 seconds
  at the default spacing.
- **AccuLynx** says its API is for AccuLynx customers, and asks software
  businesses that integrate with AccuLynx to apply to its partner program
  ([getting started](https://apidocs.acculynx.com/docs/getting-started)).
- **JobNimbus** documents no rate limit
  ([API docs](https://documenter.getpostman.com/view/3919598/S11PpG4x)). The
  client still honours `Retry-After` if one arrives.
- There is no incremental sync yet: `listContacts` reads the whole account (up
  to `maxRecords`) each time.

## Checked against the vendors' docs

Every endpoint, parameter and field this library sends or reads was checked on
2026-11-17 against the public
[JobNimbus API documentation](https://documenter.getpostman.com/view/3919598/S11PpG4x)
and the [AccuLynx API v2 reference](https://apidocs.acculynx.com). None of it has
been run against a live account. Where the docs are silent or ambiguous, this is
what the client does.

**JobNimbus**

- The docs show no response body for `POST /contacts`, `POST /jobs` or
  `POST /activities`. The client reads `jnid` from each response and throws
  `CrmResponseError` if it is missing.
- `tags` is documented as "a comma separated list of string tags", so writes
  send one comma-joined string and reject a tag that contains a comma. Reads
  accept either a string or an array.
- `owners` is documented as an array of `{ id }` with no names, so reps that
  appear only in `owners` have no name. `sales_rep_name` names the primary rep.
- `country_name` is the documented address field, not `country`.
- Deleted records and activities are filtered with `{"term":{"is_active":true}}`,
  using the documented field and filter syntax, and any `is_active: false`
  record that still comes back is dropped on the client.
- `listNotes` returns system activities too (for example "Contact Created"),
  because the docs give no reliable filter for note-only activities. Filter on
  `note.type === "Note"` if you want only notes.

**AccuLynx**

- The sales rep is not on the job record. It lives at
  `GET /jobs/{jobId}/representatives/sales-owner`, which is one request per job,
  so the adapter leaves `assignedReps` empty for now.
- With `includes=contact`, a job's contacts come back with names, but phone
  numbers and email addresses only as links. Reading them would take two more
  requests per contact, so `email` and `phone` are empty for now.
- `includes=initialAppointment` is listed as supported, but the expanded shape
  is not documented on `GET /jobs`, so `appointmentDate` is not filled.
- There is no documented endpoint for reading job messages or contact notes, so
  `listNotes` is unsupported.
- AccuLynx documents write endpoints (`POST /contacts`, `POST /jobs`, job
  messages, contact notes). This adapter does not implement them yet.
- The rate-limit reference and the changelog give different header names
  (`RateLimit-*` and `X-RateLimit-*`). The client relies only on `Retry-After`.

Found a mismatch? Open an issue with a link to the vendor doc page.

For what JobNimbus's API, automations and Zapier connector can and can't do,
in plain terms, see our
[JobNimbus automation guide](https://goodhandoff.com/blog/jobnimbus-automation-integration?utm_source=github&utm_medium=readme&utm_campaign=contractor-crm-adapters&utm_content=guide#api).

## Example script

`examples/rep-report.mjs` is a read-only report: records per status and the
sales reps on them. From a clone:

```bash
npm ci && npm run build
```

```bash
CRM_PROVIDER=jobnimbus CRM_API_KEY=your-key node examples/rep-report.mjs
```

A missing or malformed `CRM_PROVIDER`, `CRM_API_KEY` or `CRM_MAX_RECORDS`
(default 500) stops it with a message naming the variable.

## Development

```bash
npm ci
npm run check        # lint, typecheck, tests with coverage, build, TSDoc and licence checks
npm run smoke:pack   # pack, install into a temp project, import from JS (ESM and require) and TypeScript
```

Tests never touch a real CRM, and every fixture is synthetic. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the rules on fixtures, vendor docs and
DCO sign-off, which CI checks on every pull request.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). JobNimbus and AccuLynx
are trademarks of their owners, and this project is not affiliated with either.
See [TRADEMARKS.md](TRADEMARKS.md).

## Why we give this away

An AI can draft an API client in an afternoon now. That was never the hard
part of connecting a contractor's CRM. The hard part is deciding which fields
the office actually trusts, whose version wins when two systems disagree, and
who notices when a JobNimbus key expires on a Saturday. That's the work we do,
so we publish the client and keep the work.

The code is free. The handoff is the work.

**GoodHandoff** builds and runs the automation that carries a home service job
from the first call to the final payment, inside the CRM, phone and texting
tools a company already uses. If you'd rather have a JobNimbus or AccuLynx
integration built and kept running for you, that's
[what we do](https://goodhandoff.com/services/crm-integration?utm_source=github&utm_medium=readme&utm_campaign=contractor-crm-adapters&utm_content=footer#jobnimbus).
