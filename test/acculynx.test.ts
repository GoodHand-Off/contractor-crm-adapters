import { afterEach, describe, expect, it, vi } from "vitest";
import { AccuLynxClient, CrmAuthError, CrmResponseError, CrmUnsupportedError } from "../src/index.js";
import { alJob, fullJob } from "./fixtures/acculynx.js";
import { TEST_API_KEY, json, mockFetch, text } from "./helpers.js";

/** Spacing off by default in tests; one test below checks the documented default. */
function al(fetch: typeof globalThis.fetch, minRequestIntervalMs = 0) {
  return new AccuLynxClient({ apiKey: TEST_API_KEY, fetch, minRequestIntervalMs });
}

function jobs(start: number, count: number, total: number | undefined) {
  return json({
    ...(total === undefined ? {} : { count: total }),
    pageSize: 25,
    pageStartIndex: start,
    items: Array.from({ length: count }, (_, i) => alJob(start + i + 1)),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AccuLynx testConnection", () => {
  it("reads company settings from the documented base URL", async () => {
    const { fetch, calls } = mockFetch(json({ companyId: "x", name: "Example" }));
    await al(fetch).testConnection();
    expect(calls[0]?.url.toString()).toBe("https://api.acculynx.com/api/v2/company-settings");
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TEST_API_KEY}`);
  });

  it("surfaces a bad key as CrmAuthError that says where to create one", async () => {
    const { fetch } = mockFetch(text("Unauthorized", 401));
    const error = await al(fetch).testConnection().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CrmAuthError);
    expect((error as Error).message).toContain("apidocs.acculynx.com/docs/getting-started");
  });
});

describe("AccuLynx iterateContacts", () => {
  it("pages with pageSize/pageStartIndex and stops at count", async () => {
    const { fetch, calls } = mockFetch(jobs(0, 25, 60), jobs(25, 25, 60), jobs(50, 10, 60));
    const { contacts, truncated } = await al(fetch).listContacts();

    expect(contacts).toHaveLength(60);
    expect(truncated).toBe(false);
    expect(calls.map((c) => c.url.searchParams.get("pageStartIndex"))).toEqual(["0", "25", "50"]);
    for (const call of calls) {
      expect(call.url.pathname).toBe("/api/v2/jobs");
      expect(call.url.searchParams.get("pageSize")).toBe("25");
      expect(call.url.searchParams.get("includes")).toBe("contact");
      expect(call.url.searchParams.get("sortBy")).toBe("CreatedDate");
      expect(call.url.searchParams.get("sortOrder")).toBe("Ascending");
      expect(call.url.searchParams.has("recordStartIndex")).toBe(false);
    }
  });

  it("clamps pageSize to the documented maximum of 25", async () => {
    const { fetch, calls } = mockFetch(jobs(0, 0, 0));
    await al(fetch).listContacts({ pageSize: 100 });
    expect(calls[0]?.url.searchParams.get("pageSize")).toBe("25");
  });

  it("treats the documented 416 past the last record as the end", async () => {
    const { fetch, calls } = mockFetch(jobs(0, 25, undefined), text("", 416));
    const { contacts } = await al(fetch).listContacts();
    expect(contacts).toHaveLength(25);
    expect(calls).toHaveLength(2);
  });

  it("rethrows errors other than 416 mid-iteration", async () => {
    const { fetch } = mockFetch(jobs(0, 25, 100), text("boom", 500));
    await expect(al(fetch).listContacts()).rejects.toMatchObject({ status: 500 });
  });

  it.each([[{ count: 3 }], [{ items: "nope" }]])("throws CrmResponseError when a 200 has no items array (%o)", async (body) => {
    const { fetch } = mockFetch(json(body));
    await expect(al(fetch).listContacts()).rejects.toBeInstanceOf(CrmResponseError);
  });

  it("reports truncation from count when it stops at maxRecords", async () => {
    const { fetch, calls } = mockFetch(jobs(0, 25, 500));
    const { contacts, truncated } = await al(fetch).listContacts({ maxRecords: 5 });
    expect(contacts).toHaveLength(5);
    expect(truncated).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("does not report truncation when the cap equals count", async () => {
    const { fetch } = mockFetch(jobs(0, 5, 5));
    await expect(al(fetch).listContacts({ maxRecords: 5 })).resolves.toMatchObject({ truncated: false });
  });

  it("without count, judges truncation from the page", async () => {
    const full = mockFetch(jobs(0, 25, undefined));
    await expect(al(full.fetch).listContacts({ maxRecords: 25 })).resolves.toMatchObject({ truncated: true });
    const short = mockFetch(jobs(0, 3, undefined));
    await expect(al(short.fetch).listContacts({ maxRecords: 3 })).resolves.toMatchObject({ truncated: false });
  });

  it("stops on a short page without count, and skips jobs without an id or seen twice", async () => {
    const { fetch, calls } = mockFetch(json({ items: [alJob(1), { jobName: "No id" }, alJob(1), alJob(2)] }));
    const { contacts } = await al(fetch).listContacts();
    expect(contacts.map((c) => c.externalId)).toEqual([alJob(1).id, alJob(2).id]);
    expect(calls).toHaveLength(1);
  });

  it("maps the documented job fields, using the primary contact", async () => {
    const { fetch } = mockFetch(json({ count: 1, items: [fullJob] }));
    const { contacts } = await al(fetch).listContacts();

    expect(contacts[0]).toEqual({
      externalId: "00000000-0000-4000-8000-000000000001",
      name: "Pat Example",
      firstName: "Pat",
      lastName: "Example",
      address: { street: "1 Fixture Row, Unit B", city: "Testville", state: "ZZ", zip: "00000", country: "US" },
      assignedReps: [],
      status: "Approved",
      jobContext: {
        projectType: "Insurance",
        milestone: "Approved",
        leadSource: "Door Knock",
        lastActivityAt: Date.parse("2026-01-03T15:04:05Z"),
      },
    });
  });

  it("uses trade types when there is no work type, and leaves the name empty without a contact", async () => {
    const { fetch } = mockFetch(json({ count: 1, items: [alJob(2, { tradeTypes: [{ name: "Siding" }, { name: "Windows" }] })] }));
    const { contacts } = await al(fetch).listContacts();
    expect(contacts[0]?.name).toBeUndefined();
    expect(contacts[0]?.jobContext?.projectType).toBe("Siding, Windows");
  });

  it("uses the company name when the contact has no person name", async () => {
    const job = alJob(3, { contacts: [{ isPrimary: true, contact: { id: "c", companyName: "Example Holdings" } }] });
    const { fetch } = mockFetch(json({ count: 1, items: [job] }));
    const { contacts } = await al(fetch).listContacts();
    expect(contacts[0]?.name).toBe("Example Holdings");
  });

  it("spaces requests 100 ms apart by default (10 per second per key)", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = mockFetch(jobs(0, 25, 50), jobs(25, 25, 50));
    const pending = new AccuLynxClient({ apiKey: TEST_API_KEY, fetch }).listContacts();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ truncated: false });
    expect(calls).toHaveLength(2);
  });
});

describe("AccuLynx is read-only", () => {
  it("rejects every write and note read without sending a request", async () => {
    const { fetch, calls } = mockFetch();
    const client = al(fetch);
    expect(client.capabilities).toMatchObject({ listContacts: true, createContact: false, createJob: false, createNote: false, listNotes: false });
    expect(Object.isFrozen(client.capabilities)).toBe(true);
    await expect(client.createContact({ firstName: "Pat", recordTypeName: "x", statusName: "y" })).rejects.toBeInstanceOf(CrmUnsupportedError);
    await expect(client.createJob({ name: "x", recordTypeName: "x", statusName: "y" })).rejects.toBeInstanceOf(CrmUnsupportedError);
    await expect(client.createNote("id", "note")).rejects.toThrow(/check client\.capabilities/);
    await expect(client.listNotes("id")).rejects.toBeInstanceOf(CrmUnsupportedError);
    expect(calls).toHaveLength(0);
  });

  it("rejects JobNimbus-only list options", async () => {
    const { fetch, calls } = mockFetch();
    await expect(al(fetch).listContacts({ customFieldMappings: { roofDetails: "Roof" } })).rejects.toThrow(/only by the JobNimbus adapter/);
    await expect(al(fetch).listContacts({ includeDeleted: true })).rejects.toThrow(/includeDeleted is supported only by the JobNimbus adapter/);
    expect(calls).toHaveLength(0);
  });
});
