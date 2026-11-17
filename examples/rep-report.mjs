// @ts-check
/**
 * Read-only report: how many records a CRM account has per status, and which
 * sales reps appear on them. It never writes to the CRM.
 *
 * You supply the key; nothing is stored. From a clone:
 *
 *   npm ci && npm run build
 *   CRM_PROVIDER=jobnimbus CRM_API_KEY=your-key node examples/rep-report.mjs
 *
 * CRM_MAX_RECORDS (default 500) caps how many records are read.
 */
import {
  CRM_PROVIDERS,
  CrmAuthError,
  CrmRateLimitError,
  collectAssignedReps,
  createCrmClient,
  isCrmProviderName,
} from "contractor-crm-adapters";

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(message);
  process.exit(1);
}

const { CRM_PROVIDER: provider, CRM_API_KEY: apiKey } = process.env;
const rawMax = process.env.CRM_MAX_RECORDS?.trim() || "500";

if (!isCrmProviderName(provider)) {
  fail(`Set CRM_PROVIDER to "jobnimbus" or "acculynx" (got ${provider ? JSON.stringify(provider) : "nothing"}).`);
}
if (!apiKey?.trim()) fail(`Set CRM_API_KEY. ${CRM_PROVIDERS[provider].keyHelp}`);
const maxRecords = Number(rawMax);
if (!Number.isInteger(maxRecords) || maxRecords < 1) {
  fail(`CRM_MAX_RECORDS must be a whole number of at least 1 (got ${JSON.stringify(rawMax)}).`);
}

const crm = createCrmClient(provider, { apiKey, userAgent: "contractor-crm-adapters-example" });

try {
  await crm.testConnection();
  const { contacts, truncated } = await crm.listContacts({ maxRecords });

  /** @type {Map<string, number>} */
  const byStatus = new Map();
  for (const contact of contacts) {
    const status = contact.status ?? "(no status)";
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
  }

  console.log(`${crm.displayName}: read ${contacts.length} records${truncated ? ` (stopped at CRM_MAX_RECORDS=${maxRecords}; there are more)` : ""}`);
  for (const [status, count] of [...byStatus].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${status.padEnd(24)} ${count}`);
  }

  const reps = collectAssignedReps(contacts);
  console.log(`\nSales reps on these records: ${reps.length}`);
  for (const rep of reps) console.log(`  ${rep.name ?? "(no name)"}  [${rep.externalId}]`);
} catch (error) {
  if (error instanceof CrmAuthError) fail(`CRM_API_KEY was rejected. ${error.message}`);
  if (error instanceof CrmRateLimitError) fail(error.message);
  throw error;
}
