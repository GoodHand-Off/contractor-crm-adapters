import { CrmResponseError } from "../errors.js";
import { HttpClient, type CallOptions, type ClientOptions } from "../http.js";
import type {
  ContactList,
  ContactListEnd,
  CrmAddress,
  CrmAssignedRep,
  CrmCapabilities,
  CrmClient,
  CrmContact,
  CrmContactPayload,
  CrmJobContext,
  CrmJobPayload,
  CrmNote,
  CreateNoteOptions,
  CustomFieldMappings,
  ListContactsOptions,
  ListNotesOptions,
} from "../types.js";
import {
  invalid,
  numberOption,
  optionalBoolean,
  optionalObject,
  optionalString,
  optionalStringArray,
  requiredString,
} from "../validate.js";
import { compact, dateFrom, objectFrom, objectsFrom, stringFrom, type JsonObject } from "../values.js";
import { collectContacts, readCustomFields, readListOptions } from "./shared.js";

/**
 * JobNimbus public API ("api1"), as documented at
 * https://documenter.getpostman.com/view/3919598/S11PpG4x (checked 2026-11-17).
 */
const BASE_URL = "https://app.jobnimbus.com/api1";
/** Documented range for `size` is 1 to 1000. */
const MAX_PAGE_SIZE = 1000;
/** JobNimbus's own guide to querying 10k+ contacts pages 500 at a time. */
const DEFAULT_PAGE_SIZE = 500;
/** A single query cannot page past 10,000 records (from + size). */
const RESULT_WINDOW = 10_000;
const PROVIDER = "jobnimbus" as const;

/** What the JobNimbus adapter supports: everything. */
export const JOBNIMBUS_CAPABILITIES: Readonly<CrmCapabilities> = Object.freeze({
  listContacts: true,
  createContact: true,
  createJob: true,
  createNote: true,
  listNotes: true,
});

/**
 * Read and write client for JobNimbus contacts, jobs and notes.
 *
 * @example
 * ```ts
 * const jn = new JobNimbusClient({ apiKey: process.env.JOBNIMBUS_API_KEY ?? "" });
 * for await (const contact of jn.iterateContacts()) console.log(contact.name);
 * ```
 */
export class JobNimbusClient implements CrmClient {
  /** Always `"jobnimbus"`. */
  readonly provider = PROVIDER;
  /** Always `"JobNimbus"`. */
  readonly displayName = "JobNimbus";
  /** Every operation is supported. */
  readonly capabilities = JOBNIMBUS_CAPABILITIES;
  readonly #http: HttpClient;

  /**
   * Create a client. Makes no request until you call a method.
   *
   * @param options - API key and optional transport settings.
   * @throws {@link CrmValidationError} if the key is missing or an option is out of range.
   */
  constructor(options: ClientOptions) {
    this.#http = new HttpClient(PROVIDER, { baseUrl: BASE_URL, minRequestIntervalMs: 0 }, options);
  }

  /** Reads one contact ID (`GET /contacts?size=1`). Resolves when the key works. */
  async testConnection(options: CallOptions = {}): Promise<void> {
    await this.#http.request("/contacts", { query: { size: 1, fields: "jnid" }, signal: options.signal });
  }

  /**
   * Pages through `GET /contacts` oldest first, 500 per request by default,
   * skipping records JobNimbus marks deleted (`is_active: false`) unless
   * `includeDeleted` is set. Past 10,000 records it starts a new query
   * filtered on `date_created >= last seen`, as JobNimbus's guide to querying
   * 10k+ contacts describes, and drops records it has already yielded.
   */
  async *iterateContacts(options: ListContactsOptions = {}): AsyncGenerator<CrmContact, ContactListEnd, undefined> {
    const { pageSize: size, maxRecords, mappings, includeDeleted } = readListOptions(PROVIDER, options, {
      defaultSize: DEFAULT_PAGE_SIZE,
      maxSize: MAX_PAGE_SIZE,
    });
    const seen = new Set<string>();
    let from = 0;
    let lowerBound: number | undefined;
    let lastCreated: number | undefined;

    for (;;) {
      if (from + size > RESULT_WINDOW) {
        if (lastCreated === undefined || lastCreated === lowerBound) {
          throw new CrmResponseError(
            PROVIDER,
            "JobNimbus: cannot page past 10,000 contacts, because their date_created values are identical or missing.",
          );
        }
        lowerBound = lastCreated;
        from = 0;
      }

      const must: JsonObject[] = [];
      if (!includeDeleted) must.push({ term: { is_active: true } });
      if (lowerBound !== undefined) must.push({ range: { date_created: { gte: lowerBound } } });
      const data = await this.#http.request<JsonObject>("/contacts", {
        query: {
          size,
          from,
          sort_field: "date_created",
          sort_direction: "asc",
          filter: must.length > 0 ? JSON.stringify({ must }) : undefined,
        },
        signal: options.signal,
      });
      const results = listOf(data, "results", "GET /contacts");

      for (const [index, raw] of results.entries()) {
        if (typeof raw.date_created === "number") lastCreated = raw.date_created;
        // Backstop for the server-side is_active filter, which follows the docs but was not checked live.
        if (!includeDeleted && raw.is_active === false) continue;
        const contact = toContact(raw, mappings);
        if (!contact || seen.has(contact.externalId)) continue;
        seen.add(contact.externalId);
        yield contact;
        if (seen.size >= maxRecords) return { truncated: index < results.length - 1 || results.length === size };
      }

      if (results.length < size) return { truncated: false };
      from += results.length;
    }
  }

  /** Reads {@link JobNimbusClient.iterateContacts} into an array, with `truncated` set if it stopped at `maxRecords`. */
  listContacts(options: ListContactsOptions = {}): Promise<ContactList> {
    return collectContacts(this.iterateContacts(options));
  }

  /**
   * Creates a contact (`POST /contacts`). `recordTypeName` and `statusName`
   * must match a workflow and status that exist in the account.
   *
   * @returns The new contact's `jnid`.
   */
  async createContact(payload: CrmContactPayload, options: CallOptions = {}): Promise<{ externalId: string }> {
    const input = optionalObject(PROVIDER, payload, "payload") ?? invalid(PROVIDER, "payload is required");
    const firstName = optionalString(PROVIDER, input.firstName, "firstName");
    const lastName = optionalString(PROVIDER, input.lastName, "lastName");
    const company = optionalString(PROVIDER, input.companyName, "companyName");
    if (!firstName && !lastName && !company) invalid(PROVIDER, "createContact needs firstName, lastName or companyName");

    const body = compact({
      first_name: firstName,
      last_name: lastName,
      company,
      email: optionalString(PROVIDER, input.email, "email"),
      mobile_phone: optionalString(PROVIDER, input.phone, "phone"),
      record_type_name: requiredString(PROVIDER, input.recordTypeName, "recordTypeName"),
      status_name: requiredString(PROVIDER, input.statusName, "statusName"),
      ...sharedFields(input),
    });
    const created = await this.#http.request<JsonObject>("/contacts", {
      method: "POST",
      query: skipQuery(input),
      body,
      signal: options.signal,
    });
    return { externalId: requireJnid(created, "POST /contacts") };
  }

  /**
   * Creates a job (`POST /jobs`), optionally linked to an existing contact
   * through `primaryContactExternalId`.
   *
   * @returns The new job's `jnid`.
   */
  async createJob(payload: CrmJobPayload, options: CallOptions = {}): Promise<{ externalId: string }> {
    const input = optionalObject(PROVIDER, payload, "payload") ?? invalid(PROVIDER, "payload is required");
    const primaryId = optionalString(PROVIDER, input.primaryContactExternalId, "primaryContactExternalId");
    const body = compact({
      name: requiredString(PROVIDER, input.name, "name"),
      record_type_name: requiredString(PROVIDER, input.recordTypeName, "recordTypeName"),
      status_name: requiredString(PROVIDER, input.statusName, "statusName"),
      primary: primaryId ? { id: primaryId } : undefined,
      ...sharedFields(input),
    });
    const created = await this.#http.request<JsonObject>("/jobs", {
      method: "POST",
      query: skipQuery(input),
      body,
      signal: options.signal,
    });
    return { externalId: requireJnid(created, "POST /jobs") };
  }

  /**
   * Adds a "Note" activity to a contact or job (`POST /activities`).
   *
   * @returns The new activity's `jnid`.
   */
  async createNote(recordExternalId: string, note: string, options: CreateNoteOptions = {}): Promise<{ externalId: string }> {
    const id = requiredString(PROVIDER, recordExternalId, "recordExternalId");
    const text = requiredString(PROVIDER, note, "note");
    const created = await this.#http.request<JsonObject>("/activities", {
      method: "POST",
      body: compact({
        note: text,
        record_type_name: "Note",
        primary: { id },
        source: optionalString(PROVIDER, options.source, "source"),
      }),
      signal: options.signal,
    });
    return { externalId: requireJnid(created, "POST /activities") };
  }

  /**
   * The most recent activities related to a contact or job, newest first
   * (`GET /activities` filtered on `related.id`), skipping deleted ones unless
   * `includeDeleted` is set. Includes system activities such as status
   * changes; filter on `type === "Note"` for notes only.
   */
  async listNotes(recordExternalId: string, options: ListNotesOptions = {}): Promise<CrmNote[]> {
    const id = requiredString(PROVIDER, recordExternalId, "recordExternalId");
    const opts = optionalObject(PROVIDER, options, "options") ?? {};
    const size = numberOption(PROVIDER, opts.limit, "limit", { fallback: 5, min: 1, max: MAX_PAGE_SIZE, integer: true });
    const includeDeleted = optionalBoolean(PROVIDER, opts.includeDeleted, "includeDeleted") === true;
    const must: JsonObject[] = [{ term: { "related.id": id } }];
    if (!includeDeleted) must.push({ term: { is_active: true } });
    const data = await this.#http.request<JsonObject>("/activities", {
      query: { size, sort_field: "date_created", sort_direction: "desc", filter: JSON.stringify({ must }) },
      signal: options.signal,
    });
    // The documented example lists activities under "activity"; other list endpoints use "results".
    const key = Array.isArray(objectFrom(data)?.activity) ? "activity" : "results";
    return listOf(data, key, "GET /activities").flatMap((raw): CrmNote[] => {
      const content = stringFrom(raw.note);
      if (!content || (!includeDeleted && raw.is_active === false)) return [];
      const note: CrmNote = { content };
      const author = stringFrom(raw.created_by_name);
      const createdAt = dateFrom(raw.date_created);
      const type = stringFrom(raw.record_type_name);
      if (author) note.author = author;
      if (createdAt !== undefined) note.createdAt = createdAt;
      if (type) note.type = type;
      if (raw.is_archived === true) note.archived = true;
      if (raw.is_active === false) note.deleted = true;
      return [note];
    });
  }
}

/** Fields contacts and jobs share, validated and renamed to JobNimbus's documented names. */
function sharedFields(input: Record<string, unknown>): JsonObject {
  const address = optionalObject(PROVIDER, input.address, "address");
  const repId = optionalString(PROVIDER, input.assignedRepExternalId, "assignedRepExternalId");
  const tags = optionalStringArray(PROVIDER, input.tags, "tags");
  if (tags?.some((tag) => tag.includes(","))) invalid(PROVIDER, "tags may not contain commas");
  return {
    address_line1: optionalString(PROVIDER, address?.street, "address.street"),
    city: optionalString(PROVIDER, address?.city, "address.city"),
    state_text: optionalString(PROVIDER, address?.state, "address.state"),
    zip: optionalString(PROVIDER, address?.zip, "address.zip"),
    country_name: optionalString(PROVIDER, address?.country, "address.country"),
    tags: tags?.length ? tags.join(",") : undefined,
    description: optionalString(PROVIDER, input.description, "description"),
    source_name: optionalString(PROVIDER, input.sourceName, "sourceName"),
    sales_rep: repId,
    sales_rep_name: optionalString(PROVIDER, input.assignedRepName, "assignedRepName"),
    owners: repId ? [{ id: repId }] : undefined,
  };
}

function skipQuery(input: Record<string, unknown>): { skip: string | undefined } {
  const skip = [
    optionalBoolean(PROVIDER, input.skipAutomation, "skipAutomation") && "automation",
    optionalBoolean(PROVIDER, input.skipNotification, "skipNotification") && "notification",
  ].filter(Boolean);
  return { skip: skip.length > 0 ? skip.join(",") : undefined };
}

function requireJnid(created: JsonObject | undefined, route: string): string {
  const jnid = stringFrom(objectFrom(created)?.jnid);
  if (!jnid) throw new CrmResponseError(PROVIDER, `JobNimbus: ${route} succeeded but the response had no jnid.`);
  return jnid;
}

/** Map one raw JobNimbus contact to the shared shape, using documented fields only. */
function toContact(raw: JsonObject, mappings: CustomFieldMappings | undefined): CrmContact | null {
  const externalId = stringFrom(raw.jnid);
  if (!externalId) return null;

  const reps: CrmAssignedRep[] = [];
  const salesRep = stringFrom(raw.sales_rep);
  if (salesRep) {
    const name = stringFrom(raw.sales_rep_name);
    reps.push(name ? { externalId: salesRep, name } : { externalId: salesRep });
  }
  for (const owner of objectsFrom(raw.owners)) {
    const id = stringFrom(owner.id);
    // Owners carry only an id in the documented shape.
    if (id && !reps.some((rep) => rep.externalId === id)) reps.push({ externalId: id });
  }

  const firstName = stringFrom(raw.first_name);
  const lastName = stringFrom(raw.last_name);
  const street = [stringFrom(raw.address_line1), stringFrom(raw.address_line2)].filter(Boolean).join(", ");
  const address = compact<CrmAddress>({
    street: street || undefined,
    city: stringFrom(raw.city),
    state: stringFrom(raw.state_text),
    zip: stringFrom(raw.zip),
    country: stringFrom(raw.country_name),
  });
  const jobContext = compact<CrmJobContext>({
    projectType: stringFrom(raw.record_type_name),
    milestone: stringFrom(raw.status_name),
    leadSource: stringFrom(raw.source_name),
    appointmentDate: dateFrom(raw.date_start),
    lastActivityAt: dateFrom(raw.date_updated, raw.date_created),
    rawSummary: stringFrom(raw.description),
    ...(mappings ? readCustomFields(raw, mappings) : {}),
  });

  const contact: CrmContact = { externalId, assignedReps: reps };
  const name = stringFrom(raw.display_name) || [firstName, lastName].filter(Boolean).join(" ") || stringFrom(raw.company);
  const email = stringFrom(raw.email);
  const phone = stringFrom(raw.mobile_phone, raw.home_phone, raw.work_phone);
  const tags = tagsFrom(raw.tags);
  const status = stringFrom(raw.status_name);
  if (name) contact.name = name;
  if (firstName) contact.firstName = firstName;
  if (lastName) contact.lastName = lastName;
  if (email) contact.email = email;
  if (phone) contact.phone = phone;
  if (address) contact.address = address;
  if (tags) contact.tags = tags;
  if (status) contact.status = status;
  if (raw.is_archived === true) contact.archived = true;
  if (raw.is_active === false) contact.deleted = true;
  if (jobContext) contact.jobContext = jobContext;
  return contact;
}

function tagsFrom(value: unknown): string[] | undefined {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tags = list.map((tag) => stringFrom(tag)).filter((tag): tag is string => tag !== undefined);
  return tags.length > 0 ? tags : undefined;
}

/** The documented list array, or a {@link CrmResponseError}: a 200 without it must not read as "no records". */
function listOf(data: unknown, key: string, route: string): JsonObject[] {
  const list = objectFrom(data)?.[key];
  if (!Array.isArray(list)) {
    throw new CrmResponseError(PROVIDER, `JobNimbus: ${route} returned no "${key}" array, so the response cannot be read.`);
  }
  return objectsFrom(list);
}
