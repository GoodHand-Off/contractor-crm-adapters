import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccuLynxClient,
  CrmValidationError,
  JobNimbusClient,
  type ClientOptions,
  type CrmContactPayload,
  type CrmJobPayload,
} from "../src/index.js";
import { TEST_API_KEY, json, mockFetch } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jnWith(options: Partial<ClientOptions>) {
  return () => new JobNimbusClient({ apiKey: TEST_API_KEY, fetch: mockFetch().fetch, ...options });
}

/** Call with a value the static types forbid, as a plain-JavaScript caller could. */
function loose<T>(value: unknown): T {
  return value as T;
}

describe("client options", () => {
  it("names where to get a key when it is missing", () => {
    expect(() => new JobNimbusClient(loose({}))).toThrow(/apiKey is missing.*Settings > API > New API key/);
    expect(() => new AccuLynxClient({ apiKey: "" })).toThrow(/apiKey is missing.*apidocs\.acculynx\.com\/docs\/getting-started/);
    expect(() => new JobNimbusClient(loose(undefined))).toThrow(CrmValidationError);
  });

  it.each(["abc def", "abc\ndef", "abcdéf", "abc\u0000def"])("rejects a key that cannot travel in a header, without echoing it (%j)", (apiKey) => {
    const error = (() => {
      try {
        jnWith({ apiKey })();
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(CrmValidationError);
    expect((error as Error).message).toMatch(/spaces, line breaks or non-ASCII/);
    expect((error as Error).message).not.toContain("abc");
  });

  it("trims surrounding whitespace from the key", async () => {
    const { fetch, calls } = mockFetch(json({ results: [] }));
    await new JobNimbusClient({ apiKey: `  ${TEST_API_KEY}\n`, fetch }).testConnection();
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TEST_API_KEY}`);
  });

  it.each([
    [{ baseUrl: "not a url" }, /absolute URL/],
    [{ baseUrl: "http://crm.example.com/api" }, /https/],
    [{ baseUrl: "https://crm.example.com/api?x=1" }, /query string/],
    [{ baseUrl: "https://user:pass@example.com/api" }, /credentials/],
    [{ baseUrl: "https://p.example.com/jn?" }, /query string or fragment/],
    [{ baseUrl: "https://p.example.com/jn#" }, /query string or fragment/],
    [{ timeoutMs: 3e9 }, /timeoutMs must be a number from 1 to 2147483647/],
    [{ minRequestIntervalMs: 3e9 }, /minRequestIntervalMs must be a number from 0 to 2147483647/],
    [{ maxRetryDelayMs: 3e9 }, /maxRetryDelayMs must be a number from 0 to 2147483647/],
    [{ timeoutMs: Number.NaN }, /timeoutMs/],
    [{ maxRetries: Number.NaN }, /maxRetries/],
    [{ maxRetryDelayMs: Number.NaN }, /maxRetryDelayMs/],
    [{ limiter: {} }, /limiter must be a RequestLimiter/],
    [{ timeoutMs: 0 }, /timeoutMs must be a number from 1 to 2147483647/],
    [{ maxRetries: 11 }, /maxRetries must be a whole number from 0 to 10/],
    [{ maxRetries: 1.5 }, /maxRetries/],
    [{ maxRetryDelayMs: -1 }, /maxRetryDelayMs/],
    [{ minRequestIntervalMs: Number.NaN }, /minRequestIntervalMs/],
    [{ userAgent: "a\nb" }, /single line/],
    [{ userAgent: 42 }, /userAgent must be a string/],
    [{ fetch: 42 }, /fetch option/],
  ])("rejects %o", (options, message) => {
    expect(jnWith(loose<Partial<ClientOptions>>(options))).toThrow(message);
  });

  it("allows plain http only for loopback hosts", async () => {
    const { fetch, calls } = mockFetch(json({ results: [] }));
    await new JobNimbusClient({ apiKey: TEST_API_KEY, fetch, baseUrl: "http://localhost:8787/jn/" }).testConnection();
    expect(String(calls[0]?.url).split("?")[0]).toBe("http://localhost:8787/jn/contacts");
  });

  it("explains how to proceed when the runtime has no fetch", () => {
    vi.stubGlobal("fetch", undefined);
    expect(() => new JobNimbusClient({ apiKey: TEST_API_KEY })).toThrow(/no global fetch/);
  });

  it("refuses to run in a browser unless explicitly allowed", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    expect(jnWith({})).toThrow(/refusing to run in a browser/);
    expect(jnWith({ dangerouslyAllowBrowser: true })).not.toThrow();
  });
});

describe("list options", () => {
  const jn = (fetch: typeof globalThis.fetch) => new JobNimbusClient({ apiKey: TEST_API_KEY, fetch });

  it.each([
    [{ pageSize: 0 }, /pageSize must be a whole number >= 1/],
    [{ pageSize: 2.5 }, /pageSize/],
    [{ pageSize: "10" }, /pageSize/],
    [{ maxRecords: -1 }, /maxRecords/],
    [{ maxRecords: 0 }, /maxRecords must be a whole number >= 1/],
    [{ maxRecords: Number.NaN }, /maxRecords/],
    [{ pageSize: Number.NaN }, /pageSize/],
    [{ includeDeleted: "yes" }, /includeDeleted must be true or false/],
    [{ customFieldMappings: { estimatedValue: "Estimate" } }, /unknown key "estimatedValue"; valid keys: projectType/],
    [{ customFieldMappings: { estimateValue: 5 } }, /customFieldMappings\.estimateValue must be/],
    [{ customFieldMappings: { estimateValue: " " } }, /customFieldMappings\.estimateValue must be/],
    [{ customFieldMappings: "Estimate" }, /customFieldMappings must be an object/],
  ])("rejects %o before any request", async (options, message) => {
    const { fetch, calls } = mockFetch();
    await expect(jn(fetch).listContacts(loose(options))).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  });

  it("rejects options that are not an object", async () => {
    const { fetch } = mockFetch();
    await expect(jn(fetch).listContacts(loose("all"))).rejects.toThrow(/options must be an object/);
  });

  it("skips mappings left undefined", async () => {
    const { fetch } = mockFetch(json({ results: [{ jnid: "jn-1", Estimate: "100" }] }));
    const { contacts } = await jn(fetch).listContacts({ customFieldMappings: { estimateValue: "Estimate", roofDetails: undefined } });
    expect(contacts[0]?.jobContext).toEqual({ estimateValue: 100 });
  });

  it("rejects custom field mappings on AccuLynx, which has no such support", async () => {
    const { fetch, calls } = mockFetch();
    const al = new AccuLynxClient({ apiKey: TEST_API_KEY, fetch, minRequestIntervalMs: 0 });
    await expect(al.listContacts({ customFieldMappings: { roofDetails: "Roof" } })).rejects.toThrow(/only by the JobNimbus adapter/);
    expect(calls).toHaveLength(0);
  });

  it.each([0, 1001, 2.5, Number.NaN])("rejects listNotes limit %s", async (limit) => {
    const { fetch } = mockFetch();
    await expect(jn(fetch).listNotes("jn-1", { limit })).rejects.toThrow(/limit must be a whole number from 1 to 1000/);
  });
});

describe("write payloads from plain JavaScript", () => {
  const base = { firstName: "Pat", recordTypeName: "Customer", statusName: "Lead" };
  const jn = () => new JobNimbusClient({ apiKey: TEST_API_KEY, fetch: mockFetch().fetch });

  it.each([
    [undefined, /payload is required/],
    [{ ...base, email: 42 }, /email must be a string/],
    [{ ...base, tags: "storm" }, /tags must be an array of strings/],
    [{ ...base, tags: ["storm", 7] }, /tags must be an array of strings/],
    [{ ...base, address: "1 Fixture Row" }, /address must be an object/],
    [{ ...base, address: { zip: 0 } }, /address\.zip must be a string/],
    [{ ...base, skipAutomation: "yes" }, /skipAutomation must be true or false/],
    [{ ...base, assignedRepExternalId: ["r1"] }, /assignedRepExternalId must be a string/],
  ])("createContact rejects %o", async (payload, message) => {
    await expect(jn().createContact(loose<CrmContactPayload>(payload))).rejects.toThrow(message);
  });

  it.each([
    [null, /payload is required/],
    [{ name: "Roof", recordTypeName: "Job", statusName: "Lead", primaryContactExternalId: 7 }, /primaryContactExternalId must be a string/],
    [{ name: "Roof", recordTypeName: "Job" }, /statusName is required/],
  ])("createJob rejects %o", async (payload, message) => {
    await expect(jn().createJob(loose<CrmJobPayload>(payload))).rejects.toThrow(message);
  });

  it("listNotes rejects options that are not an object or a non-boolean includeDeleted", async () => {
    await expect(jn().listNotes("jn-1", loose("all"))).rejects.toThrow(/options must be an object/);
    await expect(jn().listNotes("jn-1", loose({ includeDeleted: 1 }))).rejects.toThrow(/includeDeleted must be true or false/);
  });

  it("createNote and listNotes require a record ID", async () => {
    await expect(jn().createNote("", "Hi")).rejects.toThrow(/recordExternalId is required/);
    await expect(jn().createNote("jn-1", "Hi", loose({ source: 5 }))).rejects.toThrow(/source must be a string/);
    await expect(jn().listNotes(loose(undefined))).rejects.toThrow(/recordExternalId is required/);
  });
});
