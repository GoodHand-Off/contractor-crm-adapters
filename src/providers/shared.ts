import type {
  ContactList,
  ContactListEnd,
  CrmContact,
  CrmJobContext,
  CrmProviderName,
  CustomFieldMappings,
  ListContactsOptions,
} from "../types.js";
import { invalid, numberOption, optionalBoolean, optionalObject } from "../validate.js";
import { dateFrom, numberFrom, stringFrom, type JsonObject } from "../values.js";

const DEFAULT_MAX_RECORDS = 50_000;

/** Every key of {@link CrmJobContext}, for validating custom field mappings. */
const JOB_CONTEXT_KEYS: ReadonlyArray<keyof CrmJobContext> = [
  "projectType",
  "milestone",
  "leadSource",
  "appointmentDate",
  "estimateValue",
  "contractValue",
  "collectedValue",
  "lastActivityAt",
  "lastActivitySummary",
  "roofDetails",
  "propertyDetails",
  "insuranceContext",
  "rawSummary",
];
const DATE_FIELDS = new Set<keyof CrmJobContext>(["appointmentDate", "lastActivityAt"]);
const NUMBER_FIELDS = new Set<keyof CrmJobContext>(["estimateValue", "contractValue", "collectedValue"]);

/** Drain an `iterateContacts` generator into a {@link ContactList}, keeping its `truncated` result. */
export async function collectContacts(items: AsyncGenerator<CrmContact, ContactListEnd, undefined>): Promise<ContactList> {
  const contacts: CrmContact[] = [];
  for (;;) {
    const step = await items.next();
    if (step.done) return { contacts, truncated: step.value.truncated };
    contacts.push(step.value);
  }
}

/** Validated list options. `pageSize` above the provider's maximum is clamped to it (documented behaviour). */
export interface ListSettings {
  pageSize: number;
  maxRecords: number;
  mappings: CustomFieldMappings | undefined;
  includeDeleted: boolean;
}

/** Validate list options; anything that is not a positive whole number where one is expected throws. */
export function readListOptions(
  provider: CrmProviderName,
  options: ListContactsOptions | undefined,
  page: { defaultSize: number; maxSize: number },
): ListSettings {
  const opts = optionalObject(provider, options, "options") ?? {};
  const pageSize = numberOption(provider, opts.pageSize, "pageSize", { fallback: page.defaultSize, min: 1, integer: true });
  return {
    pageSize: Math.min(pageSize, page.maxSize),
    maxRecords: numberOption(provider, opts.maxRecords, "maxRecords", { fallback: DEFAULT_MAX_RECORDS, min: 1, integer: true }),
    mappings: readMappings(provider, opts.customFieldMappings),
    includeDeleted: optionalBoolean(provider, opts.includeDeleted, "includeDeleted") ?? false,
  };
}

function readMappings(provider: CrmProviderName, value: unknown): CustomFieldMappings | undefined {
  const raw = optionalObject(provider, value, "customFieldMappings");
  if (!raw) return undefined;
  const out: CustomFieldMappings = {};
  for (const [key, fieldName] of Object.entries(raw)) {
    if (!(JOB_CONTEXT_KEYS as readonly string[]).includes(key)) {
      invalid(provider, `customFieldMappings has unknown key "${key}"; valid keys: ${JOB_CONTEXT_KEYS.join(", ")}`);
    }
    if (fieldName === undefined) continue;
    if (typeof fieldName !== "string" || !fieldName.trim()) {
      invalid(provider, `customFieldMappings.${key} must be the non-empty name of a CRM field`);
    }
    out[key as keyof CrmJobContext] = fieldName;
  }
  return out;
}

/**
 * Resolve custom field mappings against a raw record. JobNimbus documents
 * custom fields as top-level keys named by their label ("Date of Loss") or a
 * system name ("cf_date_1"), with dates as Unix seconds.
 */
export function readCustomFields(raw: JsonObject, mappings: CustomFieldMappings): Partial<CrmJobContext> {
  const fields = new Map<string, unknown>();
  for (const [key, value] of Object.entries(raw)) fields.set(normalizeFieldName(key), value);

  const out: Partial<Record<keyof CrmJobContext, string | number>> = {};
  for (const [target, fieldName] of Object.entries(mappings) as Array<[keyof CrmJobContext, string]>) {
    const value = fields.get(normalizeFieldName(fieldName));
    const parsed = DATE_FIELDS.has(target) ? dateFrom(value) : NUMBER_FIELDS.has(target) ? numberFrom(value) : stringFrom(value);
    if (parsed !== undefined) out[target] = parsed;
  }
  return out as Partial<CrmJobContext>;
}

/** "Insurance Carrier", "insurance_carrier" and "insurance-carrier" all become "insurancecarrier". */
function normalizeFieldName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}
