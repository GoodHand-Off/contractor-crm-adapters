import { CrmHttpError, CrmResponseError, CrmUnsupportedError } from "../errors.js";
import { HttpClient, type CallOptions, type ClientOptions } from "../http.js";
import type {
  ContactList,
  ContactListEnd,
  CrmAddress,
  CrmCapabilities,
  CrmClient,
  CrmContact,
  CrmJobContext,
  ListContactsOptions,
} from "../types.js";
import { invalid } from "../validate.js";
import { compact, dateFrom, numberFrom, objectFrom, objectsFrom, stringFrom, type JsonObject } from "../values.js";
import { collectContacts, readListOptions } from "./shared.js";

/** AccuLynx API v2, as documented at https://apidocs.acculynx.com (checked 2026-11-17). */
const BASE_URL = "https://api.acculynx.com/api/v2";
/** Documented maximum for `pageSize` on GET /jobs. */
const MAX_PAGE_SIZE = 25;
/** Documented limit: 10 requests per second per API key (https://apidocs.acculynx.com/docs/rate-limits). */
const MIN_REQUEST_INTERVAL_MS = 100;
const PROVIDER = "acculynx" as const;

/** What the AccuLynx adapter supports: reading jobs only. */
export const ACCULYNX_CAPABILITIES: Readonly<CrmCapabilities> = Object.freeze({
  listContacts: true,
  createContact: false,
  createJob: false,
  createNote: false,
  listNotes: false,
});

/**
 * Read-only AccuLynx client. AccuLynx organizes work around jobs, so
 * {@link AccuLynxClient.iterateContacts} yields one record per job, keyed by
 * job ID, with the job's primary contact as the person.
 *
 * Requests are spaced 100 ms apart by default (AccuLynx's documented 10 per
 * second per key).
 */
export class AccuLynxClient implements CrmClient {
  /** Always `"acculynx"`. */
  readonly provider = PROVIDER;
  /** Always `"AccuLynx"`. */
  readonly displayName = "AccuLynx";
  /** Reading jobs only; every write and `listNotes` are unsupported. */
  readonly capabilities = ACCULYNX_CAPABILITIES;
  readonly #http: HttpClient;

  /**
   * Create a client. Makes no request until you call a method.
   *
   * @param options - API key and optional transport settings.
   * @throws {@link CrmValidationError} if the key is missing or an option is out of range.
   */
  constructor(options: ClientOptions) {
    this.#http = new HttpClient(PROVIDER, { baseUrl: BASE_URL, minRequestIntervalMs: MIN_REQUEST_INTERVAL_MS }, options);
  }

  /** Reads the company settings (`GET /company-settings`). Resolves when the key works. */
  async testConnection(options: CallOptions = {}): Promise<void> {
    await this.#http.request("/company-settings", { signal: options.signal });
  }

  /**
   * Pages through `GET /jobs` oldest first, 25 per request (the documented
   * maximum), with each job's contacts expanded. Stops at the reported `count`,
   * at an empty page, or at the documented HTTP 416 past the last record.
   */
  async *iterateContacts(options: ListContactsOptions = {}): AsyncGenerator<CrmContact, ContactListEnd, undefined> {
    const { pageSize, maxRecords, mappings, includeDeleted } = readListOptions(PROVIDER, options, {
      defaultSize: MAX_PAGE_SIZE,
      maxSize: MAX_PAGE_SIZE,
    });
    if (mappings) invalid(PROVIDER, "customFieldMappings is supported only by the JobNimbus adapter");
    if (includeDeleted) invalid(PROVIDER, "includeDeleted is supported only by the JobNimbus adapter");
    const seen = new Set<string>();
    let pageStartIndex = 0;

    for (;;) {
      let data: JsonObject | undefined;
      try {
        data = await this.#http.request<JsonObject>("/jobs", {
          query: { pageSize, pageStartIndex, includes: "contact", sortBy: "CreatedDate", sortOrder: "Ascending" },
          signal: options.signal,
        });
      } catch (error) {
        if (error instanceof CrmHttpError && error.status === 416) return { truncated: false };
        throw error;
      }

      const list = objectFrom(data)?.items;
      if (!Array.isArray(list)) {
        throw new CrmResponseError(PROVIDER, 'AccuLynx: GET /jobs returned no "items" array, so the response cannot be read.');
      }
      const items = objectsFrom(list);
      const total = numberFrom(objectFrom(data)?.count);
      for (const [index, job] of items.entries()) {
        const contact = toContact(job);
        if (!contact || seen.has(contact.externalId)) continue;
        seen.add(contact.externalId);
        yield contact;
        if (seen.size >= maxRecords) {
          const read = pageStartIndex + index + 1;
          return { truncated: total !== undefined ? read < total : index < items.length - 1 || items.length === pageSize };
        }
      }

      pageStartIndex += items.length;
      if (items.length === 0 || (total !== undefined ? pageStartIndex >= total : items.length < pageSize)) {
        return { truncated: false };
      }
    }
  }

  /** Reads {@link AccuLynxClient.iterateContacts} into an array, with `truncated` set if it stopped at `maxRecords`. */
  listContacts(options: ListContactsOptions = {}): Promise<ContactList> {
    return collectContacts(this.iterateContacts(options));
  }

  /** Not supported: this adapter is read-only. Rejects with {@link CrmUnsupportedError} without sending a request. */
  readonly createContact: CrmClient["createContact"] = () => this.unsupported("createContact");
  /** Not supported: this adapter is read-only. Rejects with {@link CrmUnsupportedError} without sending a request. */
  readonly createJob: CrmClient["createJob"] = () => this.unsupported("createJob");
  /** Not supported: this adapter is read-only. Rejects with {@link CrmUnsupportedError} without sending a request. */
  readonly createNote: CrmClient["createNote"] = () => this.unsupported("createNote");
  /** Not supported: AccuLynx documents no endpoint for reading job messages or contact notes. Rejects with {@link CrmUnsupportedError}. */
  readonly listNotes: CrmClient["listNotes"] = () => this.unsupported("listNotes");

  private unsupported(operation: string): Promise<never> {
    return Promise.reject(new CrmUnsupportedError(PROVIDER, operation));
  }
}

/** Map one raw AccuLynx job to the shared shape, using documented fields only. */
function toContact(job: JsonObject): CrmContact | null {
  const externalId = stringFrom(job.id);
  if (!externalId) return null;

  const jobContacts = objectsFrom(job.contacts);
  const primary = jobContacts.find((c) => c.isPrimary === true) ?? jobContacts[0];
  const person = objectFrom(primary?.contact);
  const firstName = stringFrom(person?.firstName);
  const lastName = stringFrom(person?.lastName);

  const location = objectFrom(job.locationAddress);
  const state = objectFrom(location?.state);
  const country = objectFrom(location?.country);
  const street = [stringFrom(location?.street1), stringFrom(location?.street2)].filter(Boolean).join(", ");
  const address = compact<CrmAddress>({
    street: street || undefined,
    city: stringFrom(location?.city),
    state: stringFrom(state?.abbreviation, state?.name),
    zip: stringFrom(location?.zipCode),
    country: stringFrom(country?.abbreviation, country?.name),
  });

  const trades = objectsFrom(job.tradeTypes)
    .map((t) => stringFrom(t.name))
    .filter((name): name is string => name !== undefined);
  const milestone = stringFrom(job.currentMilestone);
  const jobContext = compact<CrmJobContext>({
    projectType: stringFrom(objectFrom(job.workType)?.name) ?? (trades.length > 0 ? trades.join(", ") : undefined),
    milestone,
    leadSource: stringFrom(objectFrom(job.leadSource)?.name),
    lastActivityAt: dateFrom(job.modifiedDate, job.createdDate),
  });

  // The sales rep is not on the job record; see README "Checked against the vendors' docs".
  const contact: CrmContact = { externalId, assignedReps: [] };
  const name = [firstName, lastName].filter(Boolean).join(" ") || stringFrom(person?.companyName);
  if (name) contact.name = name;
  if (firstName) contact.firstName = firstName;
  if (lastName) contact.lastName = lastName;
  if (address) contact.address = address;
  if (milestone) contact.status = milestone;
  if (jobContext) contact.jobContext = jobContext;
  return contact;
}
