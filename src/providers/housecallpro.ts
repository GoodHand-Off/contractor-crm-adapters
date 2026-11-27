import { CrmResponseError, CrmUnsupportedError } from "../errors.js";
import { HttpClient, type CallOptions, type ClientOptions } from "../http.js";
import type {
  ContactList,
  ContactListEnd,
  CrmAddress,
  CrmCapabilities,
  CrmClient,
  CrmContact,
  CrmContactPayload,
  CrmJobContext,
  CreateNoteOptions,
  HousecallProJobPayload,
  ListContactsOptions,
} from "../types.js";
import {
  invalid,
  optionalBoolean,
  optionalObject,
  optionalString,
  optionalStringArray,
  requiredString,
} from "../validate.js";
import { compact, dateFrom, numberFrom, objectFrom, objectsFrom, stringFrom, type JsonObject } from "../values.js";
import { collectContacts, readListOptions } from "./shared.js";

/**
 * Housecall Pro public API v1, as documented at
 * https://docs.housecallpro.com/docs/housecall-public-api/a4ca20a18010c-housecall-v1-api (read 2026-11-23).
 * Paths have no version prefix.
 */
const BASE_URL = "https://api.housecallpro.com";
/** GET /customers documents a default `page_size` of 10 and no maximum. */
const DEFAULT_PAGE_SIZE = 100;
/** Page size for reading one customer's addresses; most customers have one or two. */
const ADDRESS_PAGE_SIZE = 100;
const PROVIDER = "housecallpro" as const;

/**
 * What the Housecall Pro adapter supports: everything but reading notes back,
 * since no documented endpoint lists them with dates. Notes go on jobs only.
 */
export const HOUSECALLPRO_CAPABILITIES: Readonly<CrmCapabilities> = Object.freeze({
  listContacts: true,
  createContact: true,
  createJob: true,
  createNote: true,
  listNotes: false,
});

/** One record from a page, with its `id` already read. */
interface PageItem {
  id: string;
  record: JsonObject;
}

/** An address as Housecall Pro's create endpoints take it. */
interface AddressBody {
  street?: string | undefined;
  city?: string | undefined;
  state?: string | undefined;
  zip?: string | undefined;
  country?: string | undefined;
}

/**
 * Client for Housecall Pro customers, jobs and job notes, using a company API
 * key (`Authorization: Token <key>`). Housecall Pro offers API keys to
 * accounts on its MAX plan.
 *
 * On HTTP 429 it waits until the time in the `RateLimit-Reset` header, as
 * Housecall Pro documents, then retries.
 *
 * @example
 * ```ts
 * const hcp = new HousecallProClient({ apiKey: process.env.HOUSECALL_PRO_API_KEY ?? "" });
 * for await (const customer of hcp.iterateContacts()) console.log(customer.name);
 * ```
 */
export class HousecallProClient implements CrmClient {
  /** Always `"housecallpro"`. */
  readonly provider = PROVIDER;
  /** Always `"Housecall Pro"`. */
  readonly displayName = "Housecall Pro";
  /** Everything but `listNotes`. */
  readonly capabilities = HOUSECALLPRO_CAPABILITIES;
  readonly #http: HttpClient;

  /**
   * Create a client. Makes no request until you call a method.
   *
   * @param options - API key and optional transport settings.
   * @throws {@link CrmValidationError} if the key is missing or an option is out of range.
   */
  constructor(options: ClientOptions) {
    this.#http = new HttpClient(
      PROVIDER,
      { baseUrl: BASE_URL, minRequestIntervalMs: 0, authScheme: "Token", rateLimitReset: true },
      options,
    );
  }

  /** Reads the company record (`GET /company`). Resolves when the key works. */
  async testConnection(options: CallOptions = {}): Promise<void> {
    await this.#http.request("/company", { signal: options.signal });
  }

  /**
   * Pages through `GET /customers` oldest first (`sort_by=created_at`,
   * `sort_direction=asc`), 100 per request by default, until both the reported
   * `total_pages` and `total_items` are reached or a page comes back empty.
   */
  async *iterateContacts(options: ListContactsOptions = {}): AsyncGenerator<CrmContact, ContactListEnd, undefined> {
    const { pageSize, maxRecords, mappings, includeDeleted } = readListOptions(PROVIDER, options, {
      defaultSize: DEFAULT_PAGE_SIZE,
      maxSize: Number.POSITIVE_INFINITY,
    });
    if (mappings) invalid(PROVIDER, "customFieldMappings is supported only by the JobNimbus adapter");
    if (includeDeleted) invalid(PROVIDER, "includeDeleted is supported only by the JobNimbus adapter");

    let count = 0;
    for await (const { items, more } of this.#pages("/customers", "customers", "GET /customers", pageSize, options.signal)) {
      for (const [index, { id, record }] of items.entries()) {
        yield toContact(id, record);
        count++;
        if (count >= maxRecords) return { truncated: index < items.length - 1 || more };
      }
    }
    return { truncated: false };
  }

  /** Reads {@link HousecallProClient.iterateContacts} into an array, with `truncated` set if it stopped at `maxRecords`. */
  listContacts(options: ListContactsOptions = {}): Promise<ContactList> {
    return collectContacts(this.iterateContacts(options));
  }

  /**
   * Creates a customer (`POST /customers`). Needs `firstName`, `lastName`,
   * `email` or `phone`; Housecall Pro does not accept a company name alone.
   * `phone` is saved as the mobile number, `description` as the customer's
   * notes, `sourceName` as its lead source and `address` as its first address.
   * Customers have no assigned employee, so `assignedRepExternalId` and
   * `assignedRepName` are rejected; pass the employee ID to
   * {@link HousecallProClient.createJob} instead.
   *
   * @returns The new customer's `id`.
   */
  async createContact(payload: CrmContactPayload, options: CallOptions = {}): Promise<{ externalId: string }> {
    const input = readPayload(payload);
    rejectJobNimbusOnly(input);
    for (const field of ["assignedRepExternalId", "assignedRepName"]) {
      if (optionalString(PROVIDER, input[field], field)) {
        invalid(PROVIDER, `${field}: Housecall Pro customers have no assigned employee; pass the employee ID to createJob instead`);
      }
    }
    const firstName = optionalString(PROVIDER, input.firstName, "firstName");
    const lastName = optionalString(PROVIDER, input.lastName, "lastName");
    const email = optionalString(PROVIDER, input.email, "email");
    const phone = optionalString(PROVIDER, input.phone, "phone");
    if (!firstName && !lastName && !email && !phone) {
      invalid(PROVIDER, "createContact needs firstName, lastName, email or phone; Housecall Pro does not accept companyName alone");
    }
    const address = readAddress(input.address);
    const body = compact({
      first_name: firstName,
      last_name: lastName,
      company: optionalString(PROVIDER, input.companyName, "companyName"),
      email,
      mobile_number: phone,
      addresses: address ? [address] : undefined,
      ...sharedFields(input),
    });
    const created = await this.#http.request<JsonObject>("/customers", { method: "POST", body, signal: options.signal });
    return { externalId: requireId(created, "POST /customers") };
  }

  /**
   * Creates a job (`POST /jobs`) for the customer in `primaryContactExternalId`.
   * Housecall Pro needs the ID of one of that customer's addresses, so the
   * client first reads them (`GET /customers/{id}/addresses`):
   *
   * - With `address` (street and zip required), it uses the customer's address
   *   with the same street and zip, ignoring case, spaces, punctuation and a
   *   ZIP+4 suffix. A street without a unit matches an address with one,
   *   unless the customer has several units there, which throws. When nothing
   *   matches it adds `address` to the customer
   *   (`POST /customers/{id}/addresses`), which takes street, city, state, zip
   *   and country.
   * - Without `address`, it uses the customer's only address. If the customer
   *   has none or several, it throws.
   *
   * Those errors are {@link CrmValidationError}s, thrown before anything is
   * written. If `POST /jobs` itself fails after an address was added, the
   * address stays on the customer; calling `createJob` again finds it instead
   * of adding it twice.
   *
   * `description` is saved as the job's notes, `assignedRepExternalId` as its
   * assigned employee, `sourceName` as its lead source. Jobs have no name, so
   * `name` is rejected, and `assignedRepName` is rejected without an
   * `assignedRepExternalId`. Two to four requests, one more per extra 100
   * addresses the customer has.
   *
   * @returns The new job's `id`, which {@link HousecallProClient.createNote} takes.
   */
  async createJob(payload: HousecallProJobPayload, options: CallOptions = {}): Promise<{ externalId: string }> {
    const input = readPayload(payload);
    if (optionalString(PROVIDER, input.name, "name")) {
      invalid(PROVIDER, "name: Housecall Pro jobs have no name; put the text in description, which is saved as the job's notes");
    }
    rejectJobNimbusOnly(input);
    const customerId = requiredString(PROVIDER, input.primaryContactExternalId, "primaryContactExternalId");
    const wanted = readAddress(input.address);
    for (const part of ["street", "zip"] as const) {
      if (wanted && !wanted[part]) {
        invalid(PROVIDER, `address.${part} is required: createJob finds the customer's address by street and zip`);
      }
    }
    const repId = optionalString(PROVIDER, input.assignedRepExternalId, "assignedRepExternalId");
    if (!repId && optionalString(PROVIDER, input.assignedRepName, "assignedRepName")) {
      invalid(PROVIDER, "assignedRepName needs assignedRepExternalId: Housecall Pro assigns employees by ID only");
    }
    const fields = sharedFields(input);

    const addressId = await this.#addressFor(customerId, wanted, options.signal);
    const body = compact({
      customer_id: customerId,
      address_id: addressId,
      assigned_employee_ids: repId ? [repId] : undefined,
      ...fields,
    });
    const created = await this.#http.request<JsonObject>("/jobs", { method: "POST", body, signal: options.signal });
    return { externalId: requireId(created, "POST /jobs") };
  }

  /**
   * Adds a note to a job (`POST /jobs/{job_id}/notes`). Takes a job `id`, as
   * {@link HousecallProClient.createJob} returns it. Housecall Pro documents
   * notes on jobs only, so a customer ID (what `listContacts` returns) fails
   * with an HTTP error from Housecall Pro; the docs don't say which status.
   * `source` is rejected, since a Housecall Pro note has only its text.
   *
   * @returns The new note's `id`.
   */
  async createNote(recordExternalId: string, note: string, options: CreateNoteOptions = {}): Promise<{ externalId: string }> {
    const jobId = requiredString(PROVIDER, recordExternalId, "recordExternalId");
    const content = requiredString(PROVIDER, note, "note");
    if (optionalString(PROVIDER, optionalObject(PROVIDER, options, "options")?.source, "source")) {
      invalid(PROVIDER, "source is supported only by the JobNimbus adapter");
    }
    const created = await this.#http.request<JsonObject>(`/jobs/${encodeURIComponent(jobId)}/notes`, {
      method: "POST",
      body: { content },
      signal: options.signal,
    });
    return { externalId: requireId(created, "POST /jobs/{job_id}/notes") };
  }

  /**
   * Not supported: no documented endpoint lists a job's or customer's notes
   * with dates (`GET /jobs/{id}` returns a job's notes as text only, in no
   * stated order). Rejects with {@link CrmUnsupportedError} without sending a
   * request.
   */
  readonly listNotes: CrmClient["listNotes"] = () => Promise.reject(new CrmUnsupportedError(PROVIDER, "listNotes"));

  /** The ID of the customer's address to put the job at; see {@link HousecallProClient.createJob}. */
  async #addressFor(customerId: string, wanted: AddressBody | undefined, signal: AbortSignal | undefined): Promise<string> {
    const path = `/customers/${encodeURIComponent(customerId)}/addresses`;
    const route = "GET /customers/{customer_id}/addresses";
    const existing: PageItem[] = [];
    for await (const { items } of this.#pages(path, "addresses", route, ADDRESS_PAGE_SIZE, signal)) {
      const exact = wanted && items.find(({ record }) => addressMatch(record, wanted) === "exact");
      if (exact) return exact.id;
      existing.push(...items);
      if (!wanted && existing.length > 1) break;
    }

    if (!wanted) {
      const [only] = existing;
      if (existing.length === 1 && only) return only.id;
      return invalid(
        PROVIDER,
        existing.length === 0
          ? `createJob: customer ${customerId} has no address; pass address to add one`
          : `createJob: customer ${customerId} has more than one address; pass address to choose one`,
      );
    }

    // The street matched an address's first line, but that address has a unit the caller didn't give.
    const sameStreet = existing.filter(({ record }) => addressMatch(record, wanted) === "street");
    const units = new Set(sameStreet.map(({ record }) => comparable(stringFrom(record.street_line_2))));
    const [first] = sameStreet;
    if (first && units.size === 1) return first.id;
    if (units.size > 1) {
      invalid(PROVIDER, `createJob: customer ${customerId} has ${units.size} units at that street address; put the unit in address.street`);
    }

    const missing = (["city", "state", "country"] as const).filter((part) => !wanted[part]);
    if (missing.length > 0) {
      invalid(
        PROVIDER,
        `createJob: customer ${customerId} has no address matching that street and zip, and adding one also needs ` +
          `${missing.map((part) => `address.${part}`).join(", ")} (Housecall Pro requires street, city, state, zip and country)`,
      );
    }
    const created = await this.#http.request<JsonObject>(path, { method: "POST", body: wanted, signal });
    return requireId(created, "POST /customers/{customer_id}/addresses");
  }

  /**
   * Read a documented page-numbered list, oldest first, one request per page.
   * Keeps going while either `total_pages` or `total_items` says more remain,
   * so a server that pages smaller than asked is still read to the end; stops
   * at an empty page, or at a short one when both counts are missing. Records
   * without an `id`, or already read, are dropped; a page holding nothing new
   * while more are promised throws rather than looping.
   */
  async *#pages(
    path: string,
    key: string,
    route: string,
    pageSize: number,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<{ items: PageItem[]; more: boolean }, void, undefined> {
    const seen = new Set<string>();
    for (let page = 1; ; page++) {
      const data = await this.#http.request<JsonObject>(path, {
        query: { page, page_size: pageSize, sort_by: "created_at", sort_direction: "asc" },
        signal,
      });
      const list = objectFrom(data)?.[key];
      if (!Array.isArray(list)) {
        throw new CrmResponseError(PROVIDER, `Housecall Pro: ${route} returned no "${key}" array, so the response cannot be read.`);
      }
      const raw = objectsFrom(list);
      const items: PageItem[] = [];
      for (const record of raw) {
        const id = stringFrom(record.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        items.push({ id, record });
      }
      const totalPages = numberFrom(objectFrom(data)?.total_pages);
      const totalItems = numberFrom(objectFrom(data)?.total_items);
      const more =
        raw.length > 0 &&
        (totalPages === undefined && totalItems === undefined
          ? raw.length >= pageSize
          : (totalPages !== undefined && page < totalPages) || (totalItems !== undefined && seen.size < totalItems));
      if (more && items.length === 0) {
        throw new CrmResponseError(
          PROVIDER,
          `Housecall Pro: ${route} page ${page} held no new records with an id, so paging stopped instead of looping.`,
        );
      }
      yield { items, more };
      if (!more) return;
    }
  }
}

function readPayload(payload: unknown): Record<string, unknown> {
  return optionalObject(PROVIDER, payload, "payload") ?? invalid(PROVIDER, "payload is required");
}

/** JobNimbus-only fields: rejected rather than dropped, so a caller never believes they took effect. */
function rejectJobNimbusOnly(input: Record<string, unknown>): void {
  for (const field of ["recordTypeName", "statusName"]) {
    if (optionalString(PROVIDER, input[field], field)) invalid(PROVIDER, `${field} is supported only by the JobNimbus adapter`);
  }
  for (const field of ["skipAutomation", "skipNotification"]) {
    if (optionalBoolean(PROVIDER, input[field], field)) invalid(PROVIDER, `${field} is supported only by the JobNimbus adapter`);
  }
}

/** Fields customers and jobs share, validated and renamed to Housecall Pro's documented names. */
function sharedFields(input: Record<string, unknown>): JsonObject {
  // Read for validation only: Housecall Pro stores employees by ID, with no name alongside.
  optionalString(PROVIDER, input.assignedRepName, "assignedRepName");
  const tags = optionalStringArray(PROVIDER, input.tags, "tags");
  return {
    tags: tags?.length ? tags : undefined,
    lead_source: optionalString(PROVIDER, input.sourceName, "sourceName"),
    notes: optionalString(PROVIDER, input.description, "description"),
  };
}

/** Validate `address`. An object with no non-blank part counts as no address. */
function readAddress(value: unknown): AddressBody | undefined {
  const address = optionalObject(PROVIDER, value, "address");
  if (!address) return undefined;
  const fields: AddressBody = {
    street: optionalString(PROVIDER, address.street, "address.street"),
    city: optionalString(PROVIDER, address.city, "address.city"),
    state: optionalString(PROVIDER, address.state, "address.state"),
    zip: optionalString(PROVIDER, address.zip, "address.zip"),
    country: optionalString(PROVIDER, address.country, "address.country"),
  };
  return compact(fields);
}

/**
 * How an existing address compares with the wanted one, which has a street and
 * zip: `"exact"` when both street lines together match the wanted street,
 * `"street"` when only the first line does (the existing address has a unit
 * the caller didn't give), else `undefined`. Zips must match too.
 */
function addressMatch(existing: JsonObject, wanted: AddressBody): "exact" | "street" | undefined {
  if (zipKey(stringFrom(existing.zip)) !== zipKey(wanted.zip)) return undefined;
  const street = comparable(wanted.street);
  const line1 = stringFrom(existing.street);
  if (comparable([line1, stringFrom(existing.street_line_2)].filter(Boolean).join(", ")) === street) return "exact";
  return comparable(line1) === street ? "street" : undefined;
}

/** A US ZIP or ZIP+4 compares on its first five digits; anything else as {@link comparable} text. */
function zipKey(zip: string | undefined): string {
  return /^(\d{5})(?:[-\s]?\d{4})?$/.exec((zip ?? "").trim())?.[1] ?? comparable(zip);
}

function comparable(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function requireId(created: JsonObject | undefined, route: string): string {
  const id = stringFrom(objectFrom(created)?.id);
  if (!id) throw new CrmResponseError(PROVIDER, `Housecall Pro: ${route} succeeded but the response had no id.`);
  return id;
}

/** Map one raw Housecall Pro customer to the shared shape, using documented fields only. */
function toContact(externalId: string, raw: JsonObject): CrmContact {
  const firstName = stringFrom(raw.first_name);
  const lastName = stringFrom(raw.last_name);
  const addresses = objectsFrom(raw.addresses);
  const place = addresses.find((address) => address.type === "service") ?? addresses[0];
  const street = [stringFrom(place?.street), stringFrom(place?.street_line_2)].filter(Boolean).join(", ");
  const address = compact<CrmAddress>({
    street: street || undefined,
    city: stringFrom(place?.city),
    state: stringFrom(place?.state),
    zip: stringFrom(place?.zip),
    country: stringFrom(place?.country),
  });
  const jobContext = compact<CrmJobContext>({
    leadSource: stringFrom(raw.lead_source),
    lastActivityAt: dateFrom(raw.updated_at, raw.created_at),
    rawSummary: stringFrom(raw.notes),
  });
  const tags = (Array.isArray(raw.tags) ? raw.tags : [])
    .map((tag) => stringFrom(tag))
    .filter((tag): tag is string => tag !== undefined);

  // Customers carry no assigned employee in the documented schema.
  const contact: CrmContact = { externalId, assignedReps: [] };
  const name = [firstName, lastName].filter(Boolean).join(" ") || stringFrom(raw.company);
  const email = stringFrom(raw.email);
  const phone = stringFrom(raw.mobile_number, raw.home_number, raw.work_number);
  if (name) contact.name = name;
  if (firstName) contact.firstName = firstName;
  if (lastName) contact.lastName = lastName;
  if (email) contact.email = email;
  if (phone) contact.phone = phone;
  if (address) contact.address = address;
  if (tags.length > 0) contact.tags = tags;
  if (jobContext) contact.jobContext = jobContext;
  return contact;
}
