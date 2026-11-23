// Packs the library, installs the tarball into a throwaway project, and checks
// that it works the way a user would consume it: plain-JavaScript ESM import
// (JobNimbus and Housecall Pro),
// require() where the running Node supports require(esm), and TypeScript
// typechecking with skipLibCheck off: lib ES2022 only (no DOM, no @types/node),
// NodeNext and Bundler with DOM, and NodeNext with @types/node.
// No network: the client gets a stub fetch. The temp project is always deleted.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
const work = mkdtempSync(join(tmpdir(), "crm-adapters-smoke-"));
const run = (cmd, args) => execFileSync(cmd, args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const write = (name, text) => writeFileSync(join(work, name), text);

const stub = `
const fetch = async () =>
  new Response(JSON.stringify({ results: [{ jnid: "jn-1", first_name: "Pat", last_name: "Example", status_name: "Lead" }] }));
`;
const check = `
if (contacts.length !== 1 || contacts[0].name !== "Pat Example" || contacts[0].status !== "Lead") {
  throw new Error("unexpected result: " + JSON.stringify(contacts));
}
`;

try {
  const packed = execFileSync("npm", ["pack", "--silent", "--pack-destination", work], { cwd: root, encoding: "utf8" });
  const tarball = join(work, packed.trim().split("\n").pop());
  write("package.json", JSON.stringify({ name: "smoke", private: true, type: "module" }));
  run("npm", ["install", "--no-audit", "--no-fund", "--offline", tarball]);
  console.log(`node ${process.version}: installed ${packed.trim().split("\n").pop()}`);

  write("esm.mjs", `import { createCrmClient } from "contractor-crm-adapters";${stub}
const { contacts } = await createCrmClient("jobnimbus", { apiKey: "test-key", fetch }).listContacts();${check}
const hcpFetch = async (url, init) => {
  if (init.headers.Authorization !== "Token test-key") throw new Error("Housecall Pro needs a Token header");
  return new Response(JSON.stringify({ page: 1, total_pages: 1, customers: [{ id: "cus_1", first_name: "Pat", last_name: "Example" }] }));
};
const hcp = await createCrmClient("housecallpro", { apiKey: "test-key", fetch: hcpFetch }).listContacts();
if (hcp.contacts.length !== 1 || hcp.contacts[0].name !== "Pat Example") throw new Error("unexpected Housecall Pro result");
console.log("  esm import: ok (JobNimbus and Housecall Pro)");`);
  process.stdout.write(run(process.execPath, ["esm.mjs"]));

  if (process.features.require_module) {
    write("cjs.cjs", `const { JobNimbusClient } = require("contractor-crm-adapters");${stub}
new JobNimbusClient({ apiKey: "test-key", fetch }).listContacts().then(({ contacts }) => {${check}
  console.log("  require(): ok");
});`);
    process.stdout.write(run(process.execPath, ["cjs.cjs"]));
  } else {
    console.log("  require(): skipped, this Node has no require(esm); the package is ESM-only");
  }

  // A consumer that names no DOM or Node types: it must compile with lib ES2022 alone.
  write("consumer.ts", `import {
  createCrmClient, JobNimbusClient, HousecallProClient, CrmRateLimitError, CRM_PROVIDERS, RequestLimiter,
  type CrmClient, type CrmContact, type ContactList,
} from "contractor-crm-adapters";
const limiter = new RequestLimiter({ minIntervalMs: 40 });
const client: CrmClient = createCrmClient("acculynx", { apiKey: "k", limiter });
const jn = new JobNimbusClient({ apiKey: "k", timeoutMs: 5_000, baseUrl: undefined });
async function names(c: CrmClient): Promise<string[]> {
  const out: string[] = [];
  for await (const contact of c.iterateContacts({ maxRecords: 1, signal: undefined })) out.push(contact.name ?? contact.externalId);
  return out;
}
async function truncated(c: CrmClient): Promise<boolean> {
  const list: ContactList = await c.listContacts({ maxRecords: 10 });
  return list.truncated;
}
function retryIn(error: unknown): number | undefined {
  return error instanceof CrmRateLimitError ? error.retryAfterMs : undefined;
}
const contact: CrmContact = { externalId: "x", assignedReps: [{ externalId: "u1" }] };
const help: string = CRM_PROVIDERS.jobnimbus.keyHelp;
// @ts-expect-error an unknown provider is a type error
createCrmClient("other", { apiKey: "k" });
async function newJob(hcp: HousecallProClient): Promise<string> {
  const { externalId } = await hcp.createContact({ phone: "555-555-0102" });
  return (await hcp.createJob({ primaryContactExternalId: externalId })).externalId;
}
async function generic(crm: CrmClient): Promise<string> {
  return (await crm.createContact({ firstName: "Pat" })).externalId;
}
async function jobNimbusNeedsWorkflow(): Promise<void> {
  // @ts-expect-error JobNimbusClient.createContact requires recordTypeName and statusName
  await jn.createContact({ firstName: "Pat" });
}
export { client, jn, names, truncated, retryIn, contact, help, newJob, generic, jobNimbusNeedsWorkflow };
`);
  // A consumer that passes the platform fetch: needs DOM or Node types.
  write("consumer-fetch.ts", `import { JobNimbusClient, type FetchLike } from "contractor-crm-adapters";
const viaGlobal = new JobNimbusClient({ apiKey: "k", fetch: globalThis.fetch });
const wrapped: FetchLike = (url, init) => fetch(url, init);
const viaWrapper = new JobNimbusClient({ apiKey: "k", fetch: wrapped });
const cancelled = viaWrapper.testConnection({ signal: new AbortController().signal });
export { viaGlobal, viaWrapper, cancelled };
`);
  const base = { strict: true, noEmit: true, skipLibCheck: false, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" };
  const configs = {
    "es2022-only (no DOM, no @types/node)": { compilerOptions: { ...base, lib: ["ES2022"], types: [] }, files: ["consumer.ts"] },
    "nodenext + DOM, exactOptionalPropertyTypes": {
      compilerOptions: { ...base, lib: ["ES2022", "DOM", "DOM.Iterable"], types: [], exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true },
      files: ["consumer.ts", "consumer-fetch.ts"],
    },
    "bundler + DOM": {
      compilerOptions: { ...base, module: "ESNext", moduleResolution: "Bundler", lib: ["ES2022", "DOM", "DOM.Iterable"], types: [] },
      files: ["consumer.ts", "consumer-fetch.ts"],
    },
    "nodenext + @types/node": {
      compilerOptions: { ...base, lib: ["ES2022"], types: ["node"], typeRoots: [join(root, "node_modules", "@types")] },
      files: ["consumer.ts", "consumer-fetch.ts"],
    },
  };
  for (const [name, config] of Object.entries(configs)) {
    write("tsconfig.json", JSON.stringify(config));
    run(process.execPath, [tsc, "-p", "tsconfig.json"]);
    console.log(`  typescript, ${name}, strict, skipLibCheck off: ok`);
  }
} catch (error) {
  console.error(error.stdout || "", error.stderr || "", error.message);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
