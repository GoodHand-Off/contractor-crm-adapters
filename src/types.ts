import type { CallOptions } from "./http.js";

/** Providers this package ships an adapter for. */
export type CrmProviderName = "jobnimbus" | "acculynx" | "housecallpro";

/** A postal address as the CRMs store it. Every part is optional. */
export interface CrmAddress {
  /** Street line(s); a second line is appended after ", ". */
  street?: string;
  /** City or town. */
  city?: string;
  /** State or province, as the CRM stores it (AccuLynx: the two-letter abbreviation when present). */
  state?: string;
  /** Postal code. */
  zip?: string;
  /** Country (AccuLynx: the two-letter abbreviation when present). */
  country?: string;
}

/** A sales rep on a record. */
export interface CrmAssignedRep {
  /** The rep's user ID in the CRM. */
  externalId: string;
  /** Display name, when the CRM sends one. */
  name?: string;
}

/**
 * One customer record, normalized across providers.
 *
 * JobNimbus returns contacts and Housecall Pro returns customers. AccuLynx is
 * job-centric, so its adapter returns one `CrmContact` per job, with the job
 * ID as `externalId`.
 *
 * Email and phone are returned as the CRM stores them (trimmed only). Phone
 * formats vary by account and country, so normalizing them is left to you.
 */
export interface CrmContact {
  /** The provider's record ID (JobNimbus `jnid`, AccuLynx job `id`, Housecall Pro customer `id`). */
  externalId: string;
  /** Display name: the CRM's display name, else first and last name, else company name. */
  name?: string;
  /** Given name of the person. */
  firstName?: string;
  /** Family name of the person. */
  lastName?: string;
  /** Email address, as stored (JobNimbus and Housecall Pro; AccuLynx returns emails as links). */
  email?: string;
  /** Phone number, as stored: mobile first, then home, then work (JobNimbus and Housecall Pro). */
  phone?: string;
  /** Property or job address (Housecall Pro: the customer's first service address, else its first address). */
  address?: CrmAddress;
  /** Sales reps on the record, primary first. Empty when the CRM names none. */
  assignedReps: CrmAssignedRep[];
  /** Tag names. */
  tags?: string[];
  /** Workflow status (JobNimbus) or current milestone (AccuLynx). Housecall Pro customers have none. */
  status?: string;
  /** `true` when the CRM marks the record archived (JobNimbus `is_archived`). */
  archived?: boolean;
  /** `true` when the CRM marks the record deleted (JobNimbus `is_active: false`); only returned with `includeDeleted`. */
  deleted?: boolean;
  /** Sales context, when the CRM has any. */
  jobContext?: CrmJobContext;
}

/** Sales context pulled from the record, when the CRM has it. Dates are Unix milliseconds. */
export interface CrmJobContext {
  /** JobNimbus workflow name; AccuLynx work type, else trade types. */
  projectType?: string;
  /** Workflow status or milestone. */
  milestone?: string;
  /** Lead source name. */
  leadSource?: string;
  /** Appointment or start date, Unix ms. */
  appointmentDate?: number;
  /** Estimate total (from a custom field mapping). */
  estimateValue?: number;
  /** Contract total (from a custom field mapping). */
  contractValue?: number;
  /** Amount collected (from a custom field mapping). */
  collectedValue?: number;
  /** Last update to the record, Unix ms. */
  lastActivityAt?: number;
  /** Short description of the latest activity (from a custom field mapping). */
  lastActivitySummary?: string;
  /** Roof details (from a custom field mapping). */
  roofDetails?: string;
  /** Property details (from a custom field mapping). */
  propertyDetails?: string;
  /** Insurance carrier or claim context (from a custom field mapping). */
  insuranceContext?: string;
  /** The record's description text (Housecall Pro: the customer's notes). */
  rawSummary?: string;
}

/**
 * Maps each {@link CrmJobContext} field to the name of a JobNimbus custom
 * field: its label (e.g. "Date of Loss") or its system name (e.g.
 * "cf_date_1"). Matching ignores case, spaces, underscores and hyphens.
 * Unknown keys are rejected.
 */
export type CustomFieldMappings = Partial<Record<keyof CrmJobContext, string>>;

/** A note or activity on a record. */
export interface CrmNote {
  /** The note text. */
  content: string;
  /** Who created it, when the CRM says. */
  author?: string;
  /** When it was created, Unix ms, when the CRM says. */
  createdAt?: number;
  /** The CRM's activity type, e.g. JobNimbus "Note" or a system event such as "Contact Created". */
  type?: string;
  /** `true` when the CRM marks the note archived (JobNimbus `is_archived`). */
  archived?: boolean;
  /** `true` when the CRM marks the note deleted (JobNimbus `is_active: false`); only returned with `includeDeleted`. */
  deleted?: boolean;
}

/** Fields shared by contact and job creation. */
interface CrmRecordPayloadBase {
  /**
   * Property address. Housecall Pro `createJob`: the job's address, found among
   * the customer's addresses or added to them; see {@link HousecallProClient.createJob}.
   */
  address?: CrmAddress | undefined;
  /** Tag names. JobNimbus stores them as one comma-separated string, so a tag may not contain a comma there. */
  tags?: string[] | undefined;
  /** Saved as the record's description (Housecall Pro: its notes). */
  description?: string | undefined;
  /** Provider user ID of the sales rep to assign (Housecall Pro: an employee ID, on jobs only). */
  assignedRepExternalId?: string | undefined;
  /** Sales rep display name, for providers that store it alongside the ID (JobNimbus). Housecall Pro ignores it next to an ID and rejects it without one. */
  assignedRepName?: string | undefined;
  /** Lead source name. JobNimbus requires one defined in the account. */
  sourceName?: string | undefined;
  /** JobNimbus `?skip=automation`: do not fire the account's automation rules for this write. Other adapters reject `true`. */
  skipAutomation?: boolean | undefined;
  /** JobNimbus `?skip=notification`: do not send email or push notifications for this write. Other adapters reject `true`. */
  skipNotification?: boolean | undefined;
}

/**
 * Input for {@link CrmClient.createContact}. JobNimbus needs `firstName`,
 * `lastName` or `companyName`; Housecall Pro needs `firstName`, `lastName`,
 * `email` or `phone`.
 */
export interface CrmContactPayload extends CrmRecordPayloadBase {
  /** Given name. */
  firstName?: string | undefined;
  /** Family name. */
  lastName?: string | undefined;
  /** Company name, for commercial customers. */
  companyName?: string | undefined;
  /** Email address. */
  email?: string | undefined;
  /** Saved as the mobile phone. */
  phone?: string | undefined;
  /** JobNimbus contact workflow (record type) name, e.g. "Customer". Must exist in the account. Required by JobNimbus; other adapters reject it. */
  recordTypeName?: string | undefined;
  /** JobNimbus status within that workflow, e.g. "Lead". Must exist in the account. Required by JobNimbus; other adapters reject it. */
  statusName?: string | undefined;
}

/** Input for {@link CrmClient.createJob}. */
export interface CrmJobPayload extends CrmRecordPayloadBase {
  /** Job name, e.g. "Example roof replacement". Required by JobNimbus; Housecall Pro jobs have no name, so it rejects it. */
  name?: string | undefined;
  /** JobNimbus job workflow (record type) name. Must exist in the account. Required by JobNimbus; other adapters reject it. */
  recordTypeName?: string | undefined;
  /** JobNimbus status within that workflow. Must exist in the account. Required by JobNimbus; other adapters reject it. */
  statusName?: string | undefined;
  /** Link the job to an existing contact by its `externalId`. Required by Housecall Pro, where every job belongs to a customer. */
  primaryContactExternalId?: string | undefined;
}

/** A {@link CrmContactPayload} with the fields JobNimbus requires. What {@link JobNimbusClient.createContact} accepts. */
export interface JobNimbusContactPayload extends CrmContactPayload {
  /** Contact workflow (record type) name, e.g. "Customer". Must exist in the account. */
  recordTypeName: string;
  /** Status within that workflow, e.g. "Lead". Must exist in the account. */
  statusName: string;
}

/** A {@link CrmJobPayload} with the fields JobNimbus requires. What {@link JobNimbusClient.createJob} accepts. */
export interface JobNimbusJobPayload extends CrmJobPayload {
  /** Job name, e.g. "Example roof replacement". */
  name: string;
  /** Job workflow (record type) name. Must exist in the account. */
  recordTypeName: string;
  /** Status within that workflow. Must exist in the account. */
  statusName: string;
}

/** A {@link CrmJobPayload} with the field Housecall Pro requires. What {@link HousecallProClient.createJob} accepts. */
export interface HousecallProJobPayload extends CrmJobPayload {
  /** The customer the job is for: a Housecall Pro customer `id`, as `createContact` or `listContacts` return it. */
  primaryContactExternalId: string;
}

/** What an adapter can do. Calling an unsupported method rejects with `CrmUnsupportedError`. */
export interface CrmCapabilities {
  /** `iterateContacts` and `listContacts`. */
  listContacts: boolean;
  /** `createContact`. */
  createContact: boolean;
  /** `createJob`. */
  createJob: boolean;
  /** `createNote`. Housecall Pro takes job IDs only. */
  createNote: boolean;
  /** `listNotes`. */
  listNotes: boolean;
}

/** Options for {@link CrmClient.iterateContacts} and {@link CrmClient.listContacts}. */
export interface ListContactsOptions extends CallOptions {
  /**
   * Records per request: a whole number of at least 1, clamped to the
   * provider's documented maximum (JobNimbus 1000, AccuLynx 25). Housecall Pro
   * documents none, so it is sent as given (default 100).
   */
  pageSize?: number | undefined;
  /** Stop after this many records: a whole number of at least 1. Default 50,000. Check `truncated` on the result. */
  maxRecords?: number | undefined;
  /** Fill {@link CrmJobContext} from custom fields. JobNimbus only; the other adapters reject it. */
  customFieldMappings?: CustomFieldMappings | undefined;
  /** Also return records the CRM marks deleted (JobNimbus `is_active: false`). Default `false`. JobNimbus only; the other adapters reject it. */
  includeDeleted?: boolean | undefined;
}

/** How a listing ended. */
export interface ContactListEnd {
  /** `true` when the client stopped at `maxRecords` and the CRM may hold more records. */
  truncated: boolean;
}

/** The result of {@link CrmClient.listContacts}. */
export interface ContactList extends ContactListEnd {
  /** The records read, oldest first. */
  contacts: CrmContact[];
}

/** Options for {@link CrmClient.listNotes}. */
export interface ListNotesOptions extends CallOptions {
  /** Most recent N notes, a whole number from 1 to 1000. Default 5. */
  limit?: number | undefined;
  /** Also return activities the CRM marks deleted (JobNimbus `is_active: false`). Default `false`. */
  includeDeleted?: boolean | undefined;
}

/** Options for {@link CrmClient.createNote}. */
export interface CreateNoteOptions extends CallOptions {
  /** Shown as the activity's source in the CRM, e.g. your app's name. JobNimbus only; Housecall Pro rejects it. */
  source?: string | undefined;
}

/**
 * The provider-neutral surface every adapter implements. Every method that
 * calls the CRM throws the typed errors exported by this package.
 */
export interface CrmClient {
  /** Which adapter this is. */
  readonly provider: CrmProviderName;
  /** Name to show users, e.g. "JobNimbus". */
  readonly displayName: string;
  /** Which methods the adapter supports. */
  readonly capabilities: Readonly<CrmCapabilities>;
  /** Make one cheap authenticated read. Resolves when the key works; throws `CrmAuthError` when it does not. */
  testConnection(options?: CallOptions): Promise<void>;
  /**
   * Stream records page by page, one request per page, oldest first. The
   * generator's return value says whether it stopped at `maxRecords`.
   */
  iterateContacts(options?: ListContactsOptions): AsyncGenerator<CrmContact, ContactListEnd, undefined>;
  /** Read records into an array, with `truncated` set if it stopped at `maxRecords`. */
  listContacts(options?: ListContactsOptions): Promise<ContactList>;
  /** Create a contact. Resolves with the new record's ID. */
  createContact(payload: CrmContactPayload, options?: CallOptions): Promise<{ externalId: string }>;
  /** Create a job. Resolves with the new record's ID. */
  createJob(payload: CrmJobPayload, options?: CallOptions): Promise<{ externalId: string }>;
  /** Add a note to a contact or job (Housecall Pro: jobs only). Resolves with the new note's ID. */
  createNote(recordExternalId: string, note: string, options?: CreateNoteOptions): Promise<{ externalId: string }>;
  /** Read the most recent notes on a contact or job, newest first. */
  listNotes(recordExternalId: string, options?: ListNotesOptions): Promise<CrmNote[]>;
}
