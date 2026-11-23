import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CrmAuthError,
  CrmNotFoundError,
  CrmRateLimitError,
  CrmResponseError,
  CrmUnsupportedError,
  CrmValidationError,
  HousecallProClient,
  type CrmContactPayload,
  type HousecallProJobPayload,
} from "../src/index.js";
import { fullCustomer, hcpAddress, hcpCustomer } from "./fixtures/housecallpro.js";
import { TEST_API_KEY, json, mockFetch, text } from "./helpers.js";

function hcp(fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) {
  return new HousecallProClient({ apiKey: TEST_API_KEY, fetch, ...extra });
}

/** A GET /customers page in the documented shape. */
function customers(page: number, count: number, totalPages: number | undefined, pageSize = 100, first = (page - 1) * pageSize + 1) {
  return json({
    page,
    page_size: pageSize,
    ...(totalPages === undefined ? {} : { total_pages: totalPages, total_items: totalPages * pageSize }),
    customers: Array.from({ length: count }, (_, i) => hcpCustomer(first + i)),
  });
}

/** A GET /customers/{id}/addresses page in the documented shape. */
function addresses(list: Array<Record<string, unknown>>, page = 1, totalPages = 1) {
  return json({ page, page_size: 100, total_pages: totalPages, total_items: list.length, addresses: list });
}

/** Call with a value the static types forbid, as a plain-JavaScript caller could. */
function loose<T>(value: unknown): T {
  return value as T;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Housecall Pro testConnection", () => {
  it("reads the company from the documented base URL with a Token header", async () => {
    const { fetch, calls } = mockFetch(json({ id: "company-fixture", name: "Fixture Roofing Co" }));
    await hcp(fetch).testConnection();
    expect(calls[0]?.url.toString()).toBe("https://api.housecallpro.com/company");
    expect(calls[0]?.headers.authorization).toBe(`Token ${TEST_API_KEY}`);
  });

  it("surfaces a bad key as CrmAuthError that says where to create one", async () => {
    const { fetch } = mockFetch(text("Unauthorized", 401));
    const error = await hcp(fetch).testConnection().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CrmAuthError);
    expect((error as Error).message).toContain("My Apps > All Apps > API Key Management");
    expect((error as Error).message).toContain("help.housecallpro.com/en/articles/8505035-api-overview");
  });

  it("waits until the RateLimit-Reset time after a 429, then retries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-01-01T00:00:00Z"));
    const reset = String(Date.parse("2026-01-01T00:00:04Z") / 1000);
    const { fetch, calls } = mockFetch(text("", 429, { "ratelimit-reset": reset }), json({ id: "company-fixture" }));
    const pending = hcp(fetch).testConnection();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(calls).toHaveLength(2);
  });

  it("throws CrmRateLimitError at once when the reset is further out than maxRetryDelayMs", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 3_600);
    const { fetch, calls } = mockFetch(text("", 429, { "ratelimit-reset": reset }));
    const error = await hcp(fetch).testConnection().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CrmRateLimitError);
    expect((error as CrmRateLimitError).retryAfterMs).toBeGreaterThan(3_500_000);
    expect(calls).toHaveLength(1);
  });
});

describe("Housecall Pro iterateContacts", () => {
  it("pages with page/page_size, oldest first, and stops at total_pages", async () => {
    const { fetch, calls } = mockFetch(customers(1, 2, 3, 2), customers(2, 2, 3, 2), customers(3, 1, 3, 2));
    const { contacts, truncated } = await hcp(fetch).listContacts({ pageSize: 2 });

    expect(contacts.map((c) => c.externalId)).toEqual([
      "cus_fixture00001",
      "cus_fixture00002",
      "cus_fixture00003",
      "cus_fixture00004",
      "cus_fixture00005",
    ]);
    expect(truncated).toBe(false);
    expect(calls.map((c) => c.url.searchParams.get("page"))).toEqual(["1", "2", "3"]);
    for (const call of calls) {
      expect(call.url.pathname).toBe("/customers");
      expect(call.url.searchParams.get("page_size")).toBe("2");
      expect(call.url.searchParams.get("sort_by")).toBe("created_at");
      expect(call.url.searchParams.get("sort_direction")).toBe("asc");
    }
  });

  it("asks for 100 per page by default and sends a larger pageSize as given, since no maximum is documented", async () => {
    const first = mockFetch(customers(1, 0, 0));
    await hcp(first.fetch).listContacts();
    expect(first.calls[0]?.url.searchParams.get("page_size")).toBe("100");

    const second = mockFetch(customers(1, 0, 0));
    await hcp(second.fetch).listContacts({ pageSize: 500 });
    expect(second.calls[0]?.url.searchParams.get("page_size")).toBe("500");
  });

  it("follows total_pages even when the server pages smaller than asked", async () => {
    const { fetch, calls } = mockFetch(customers(1, 10, 2, 10), customers(2, 10, 2, 10));
    const { contacts } = await hcp(fetch).listContacts({ pageSize: 100 });
    expect(contacts).toHaveLength(20);
    expect(calls).toHaveLength(2);
  });

  it("stops at a short page, or an empty one, when total_pages is missing", async () => {
    const short = mockFetch(customers(1, 2, undefined, 2), customers(2, 1, undefined, 2));
    expect((await hcp(short.fetch).listContacts({ pageSize: 2 })).contacts).toHaveLength(3);
    expect(short.calls).toHaveLength(2);

    const empty = mockFetch(customers(1, 2, undefined, 2), customers(2, 0, undefined, 2));
    expect((await hcp(empty.fetch).listContacts({ pageSize: 2 })).contacts).toHaveLength(2);
    expect(empty.calls).toHaveLength(2);
  });

  it("maps a customer to the shared shape", async () => {
    const { fetch } = mockFetch(json({ page: 1, page_size: 100, total_pages: 1, total_items: 1, customers: [fullCustomer] }));
    const { contacts } = await hcp(fetch).listContacts();
    expect(contacts[0]).toEqual({
      externalId: "cus_fixture00001",
      name: "Pat Example",
      firstName: "Pat",
      lastName: "Example",
      email: "pat@example.com",
      phone: "555-555-0101",
      address: { street: "1 Fixture Row, Unit B", city: "Testville", state: "ZZ", zip: "00000", country: "US" },
      assignedReps: [],
      tags: ["storm", "canvassing"],
      jobContext: {
        leadSource: "Door Knock",
        lastActivityAt: Date.parse("2026-01-03T15:04:05Z"),
        rawSummary: "Prefers texts after 5 PM.",
      },
    });
  });

  it("names a company-only customer by its company, takes the first address when none is a service address, and skips records without an id", async () => {
    const companyOnly = hcpCustomer(2, {
      first_name: null,
      last_name: null,
      company: "Example Property Management",
      mobile_number: "555-555-0102",
      created_at: "not a date",
      updated_at: null,
      tags: "storm",
      addresses: [hcpAddress(4, { type: "billing" })],
    });
    const { fetch } = mockFetch(
      json({ page: 1, page_size: 100, total_pages: 1, total_items: 3, customers: [{ first_name: "No Id" }, companyOnly, "junk"] }),
    );
    const { contacts } = await hcp(fetch).listContacts();
    expect(contacts).toEqual([
      {
        externalId: "cus_fixture00002",
        name: "Example Property Management",
        phone: "555-555-0102",
        address: { street: "4 Fixture Row", city: "Testville", state: "ZZ", zip: "00000", country: "US" },
        assignedReps: [],
      },
    ]);
  });

  it("stops at maxRecords and reports whether more remain", async () => {
    const midPage = mockFetch(customers(1, 3, 1, 3));
    expect(await hcp(midPage.fetch).listContacts({ pageSize: 3, maxRecords: 2 })).toMatchObject({ truncated: true });

    const endOfPage = mockFetch(customers(1, 2, 2, 2));
    const more = await hcp(endOfPage.fetch).listContacts({ pageSize: 2, maxRecords: 2 });
    expect(more).toMatchObject({ truncated: true });
    expect(more.contacts).toHaveLength(2);
    expect(endOfPage.calls).toHaveLength(1);

    const exact = mockFetch(customers(1, 2, 1, 2));
    expect(await hcp(exact.fetch).listContacts({ pageSize: 2, maxRecords: 2 })).toMatchObject({ truncated: false });
  });

  it("drops a record repeated on a later page", async () => {
    const { fetch } = mockFetch(customers(1, 2, 2, 2), customers(2, 2, 2, 2, 2));
    const { contacts } = await hcp(fetch).listContacts({ pageSize: 2 });
    expect(contacts.map((c) => c.externalId)).toEqual(["cus_fixture00001", "cus_fixture00002", "cus_fixture00003"]);
  });

  it("throws instead of looping when a page holds only records already read", async () => {
    const { fetch, calls } = mockFetch(customers(1, 2, 5, 2), customers(2, 2, 5, 2, 1));
    await expect(hcp(fetch).listContacts({ pageSize: 2 })).rejects.toThrow(/page 2 held only records already read/);
    expect(calls).toHaveLength(2);
  });

  it.each([[{ page: 1, total_pages: 1 }], [{ customers: "nope" }]])("throws CrmResponseError when a 200 has no customers array (%o)", async (body) => {
    const { fetch } = mockFetch(json(body));
    await expect(hcp(fetch).listContacts()).rejects.toBeInstanceOf(CrmResponseError);
  });

  it.each([[{ customFieldMappings: { roofDetails: "Roof" } }], [{ includeDeleted: true }]])("rejects JobNimbus-only option %o before any request", async (options) => {
    const { fetch, calls } = mockFetch();
    await expect(hcp(fetch).listContacts(options)).rejects.toThrow(/only by the JobNimbus adapter/);
    expect(calls).toHaveLength(0);
  });
});

describe("Housecall Pro createContact", () => {
  it("posts a customer with documented field names and returns its id", async () => {
    const { fetch, calls } = mockFetch(json({ id: "cus_new" }, 201));
    const result = await hcp(fetch).createContact({
      firstName: " Pat ",
      lastName: "Example",
      companyName: "Example Holdings",
      email: "pat@example.com",
      phone: "555-555-0102",
      address: { street: "1 Fixture Row", city: "Testville", state: "ZZ", zip: "00000" },
      tags: ["storm", " ", "canvassing"],
      sourceName: "Door Knock",
      description: "Met at the door.",
      assignedRepName: "Ignored Name",
      skipAutomation: false,
    });

    expect(result).toEqual({ externalId: "cus_new" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.toString()).toBe("https://api.housecallpro.com/customers");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(calls[0]?.body).toEqual({
      first_name: "Pat",
      last_name: "Example",
      company: "Example Holdings",
      email: "pat@example.com",
      mobile_number: "555-555-0102",
      addresses: [{ street: "1 Fixture Row", city: "Testville", state: "ZZ", zip: "00000" }],
      tags: ["storm", "canvassing"],
      lead_source: "Door Knock",
      notes: "Met at the door.",
    });
  });

  it("accepts an email or phone alone, as Housecall Pro does", async () => {
    const { fetch, calls } = mockFetch(json({ id: "cus_a" }), json({ id: "cus_b" }));
    await hcp(fetch).createContact({ email: "pat@example.com" });
    await hcp(fetch).createContact({ phone: "555-555-0102", address: {} });
    expect(calls.map((c) => c.body)).toEqual([{ email: "pat@example.com" }, { mobile_number: "555-555-0102" }]);
  });

  it.each([
    [{ companyName: "Example Holdings" }, /needs firstName, lastName, email or phone; Housecall Pro does not accept companyName alone/],
    [{ firstName: "Pat", recordTypeName: "Customer" }, /recordTypeName is supported only by the JobNimbus adapter/],
    [{ firstName: "Pat", statusName: "Lead" }, /statusName is supported only by the JobNimbus adapter/],
    [{ firstName: "Pat", skipAutomation: true }, /skipAutomation is supported only by the JobNimbus adapter/],
    [{ firstName: "Pat", skipNotification: true }, /skipNotification is supported only by the JobNimbus adapter/],
    [{ firstName: "Pat", assignedRepExternalId: "pro_1" }, /customers have no assigned employee; pass it to createJob/],
    [{ firstName: "Pat", tags: "storm" }, /tags must be an array of strings/],
    [{ firstName: "Pat", address: { zip: 0 } }, /address\.zip must be a string/],
    [{ firstName: "Pat", assignedRepName: 5 }, /assignedRepName must be a string/],
    [null, /payload is required/],
  ])("rejects %o before any request", async (payload, message) => {
    const { fetch, calls } = mockFetch();
    const error = await hcp(fetch).createContact(loose<CrmContactPayload>(payload)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CrmValidationError);
    expect((error as Error).message).toMatch(message);
    expect(calls).toHaveLength(0);
  });

  it("throws CrmResponseError when the 201 has no id", async () => {
    const { fetch } = mockFetch(json({ first_name: "Pat" }, 201));
    await expect(hcp(fetch).createContact({ firstName: "Pat" })).rejects.toThrow(/POST \/customers succeeded but the response had no id/);
  });
});

describe("Housecall Pro createJob", () => {
  const job = { id: "job_new" };

  it("uses the customer's only address when none is given", async () => {
    const { fetch, calls } = mockFetch(addresses([hcpAddress(1)]), json(job, 201));
    const result = await hcp(fetch).createJob({
      primaryContactExternalId: "cus_fixture00001",
      assignedRepExternalId: "pro_fixture1",
      tags: ["storm"],
      sourceName: "Door Knock",
      description: "Inspect the north slope.",
    });

    expect(result).toEqual({ externalId: "job_new" });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url.pathname).toBe("/customers/cus_fixture00001/addresses");
    expect(calls[0]?.url.searchParams.get("page")).toBe("1");
    expect(calls[0]?.url.searchParams.get("page_size")).toBe("100");
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.url.toString()).toBe("https://api.housecallpro.com/jobs");
    expect(calls[1]?.body).toEqual({
      customer_id: "cus_fixture00001",
      address_id: "adr_fixture00001",
      assigned_employee_ids: ["pro_fixture1"],
      tags: ["storm"],
      lead_source: "Door Knock",
      notes: "Inspect the north slope.",
    });
  });

  it("uses a matching address, ignoring case, spaces and punctuation, without adding one", async () => {
    const existing = [hcpAddress(2), hcpAddress(1, { street: "1 Fixture Row", street_line_2: "Unit B", zip: "00000" })];
    const { fetch, calls } = mockFetch(addresses(existing), json(job, 201));
    await hcp(fetch).createJob({
      primaryContactExternalId: "cus_fixture00001",
      address: { street: "1  fixture row,  unit b.", city: "Testville", state: "ZZ", zip: "00000", country: "US" },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toEqual({ customer_id: "cus_fixture00001", address_id: "adr_fixture00001" });
  });

  it("matches on the first street line alone too", async () => {
    const { fetch, calls } = mockFetch(addresses([hcpAddress(3, { street_line_2: "Rear" })]), json(job, 201));
    await hcp(fetch).createJob({
      primaryContactExternalId: "cus_fixture00001",
      address: { street: "3 Fixture Row", city: "Testville", state: "ZZ", zip: "00000", country: "US" },
    });
    expect(calls[1]?.body).toMatchObject({ address_id: "adr_fixture00003" });
  });

  it("adds the address to the customer when none matches, then uses it", async () => {
    const { fetch, calls } = mockFetch(addresses([hcpAddress(1)]), json(hcpAddress(7)), json(job, 201));
    const address = { street: "7 Fixture Row", city: "Testville", state: "ZZ", zip: "00000", country: "US" };
    await hcp(fetch).createJob({ primaryContactExternalId: "cus_fixture00001", address });

    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "GET /customers/cus_fixture00001/addresses",
      "POST /customers/cus_fixture00001/addresses",
      "POST /jobs",
    ]);
    expect(calls[1]?.body).toEqual(address);
    expect(calls[2]?.body).toMatchObject({ address_id: "adr_fixture00007" });
  });

  it("reads every page of a customer's addresses before deciding", async () => {
    const { fetch, calls } = mockFetch(addresses([hcpAddress(1)], 1, 2), addresses([hcpAddress(2)], 2, 2), json(job, 201));
    await hcp(fetch).createJob({
      primaryContactExternalId: "cus_fixture00001",
      address: { street: "2 Fixture Row", city: "Testville", state: "ZZ", zip: "00000", country: "US" },
    });
    expect(calls.map((c) => c.url.searchParams.get("page"))).toEqual(["1", "2", null]);
    expect(calls[2]?.body).toMatchObject({ address_id: "adr_fixture00002" });
  });

  it("encodes the customer ID in the path", async () => {
    const { fetch, calls } = mockFetch(addresses([hcpAddress(1)]), json(job, 201));
    await hcp(fetch).createJob({ primaryContactExternalId: "cus/../x?y" });
    expect(calls[0]?.url.pathname).toBe("/customers/cus%2F..%2Fx%3Fy/addresses");
  });

  it.each([
    [[], /customer cus_fixture00001 has no address; pass address to add one/],
    [[hcpAddress(1), hcpAddress(2)], /customer cus_fixture00001 has 2 addresses; pass address to choose one/],
  ])("creates nothing when the customer's address is ambiguous (%#)", async (list, message) => {
    const { fetch, calls } = mockFetch(addresses(list));
    const error = await hcp(fetch).createJob({ primaryContactExternalId: "cus_fixture00001" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CrmValidationError);
    expect((error as Error).message).toMatch(message);
    expect(calls).toHaveLength(1);
  });

  it.each([
    [{}, /primaryContactExternalId is required/],
    [{ primaryContactExternalId: "cus_1", name: "Roof" }, /jobs have no name; put the text in description/],
    [{ primaryContactExternalId: "cus_1", recordTypeName: "Job" }, /recordTypeName is supported only by the JobNimbus adapter/],
    [{ primaryContactExternalId: "cus_1", address: { street: "1 Fixture Row", zip: "00000" } }, /address\.city is required: Housecall Pro needs street, city, state, zip and country/],
    [{ primaryContactExternalId: "cus_1", address: { street: "1 Fixture Row", city: "Testville", state: "ZZ", zip: "00000" } }, /address\.country is required/],
    [{ primaryContactExternalId: "cus_1", assignedRepExternalId: 7 }, /assignedRepExternalId must be a string/],
    [undefined, /payload is required/],
  ])("rejects %o before any request", async (payload, message) => {
    const { fetch, calls } = mockFetch();
    await expect(hcp(fetch).createJob(loose<HousecallProJobPayload>(payload))).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  });

  it("surfaces an unknown customer as CrmNotFoundError and creates nothing", async () => {
    const { fetch, calls } = mockFetch(text("", 404));
    await expect(hcp(fetch).createJob({ primaryContactExternalId: "cus_missing" })).rejects.toBeInstanceOf(CrmNotFoundError);
    expect(calls).toHaveLength(1);
  });

  it("throws CrmResponseError when an address list or a created record has no id", async () => {
    const noList = mockFetch(json({ page: 1, total_pages: 1 }));
    await expect(hcp(noList.fetch).createJob({ primaryContactExternalId: "cus_1" })).rejects.toThrow(/returned no "addresses" array/);

    const noAddressId = mockFetch(addresses([]), json({ street: "7 Fixture Row" }));
    const address = { street: "7 Fixture Row", city: "Testville", state: "ZZ", zip: "00000", country: "US" };
    await expect(hcp(noAddressId.fetch).createJob({ primaryContactExternalId: "cus_1", address })).rejects.toThrow(
      /POST \/customers\/\{customer_id\}\/addresses succeeded but the response had no id/,
    );

    const noJobId = mockFetch(addresses([hcpAddress(1)]), json({}, 201));
    await expect(hcp(noJobId.fetch).createJob({ primaryContactExternalId: "cus_1" })).rejects.toThrow(/POST \/jobs succeeded/);
  });
});

describe("Housecall Pro notes", () => {
  it("adds a note to a job and returns its id", async () => {
    const { fetch, calls } = mockFetch(json({ id: "note_new", content: "Homeowner asked for a Saturday inspection." }, 201));
    const result = await hcp(fetch).createNote("job_fixture1", " Homeowner asked for a Saturday inspection. ");
    expect(result).toEqual({ externalId: "note_new" });
    expect(calls[0]?.url.toString()).toBe("https://api.housecallpro.com/jobs/job_fixture1/notes");
    expect(calls[0]?.body).toEqual({ content: "Homeowner asked for a Saturday inspection." });
  });

  it.each([
    [["", "Hi"], /recordExternalId is required/],
    [["job_1", " "], /note is required/],
    [["job_1", "Hi", { source: "Your App" }], /source is supported only by the JobNimbus adapter/],
    [["job_1", "Hi", "all"], /options must be an object/],
  ])("rejects %j before any request", async (args, message) => {
    const { fetch, calls } = mockFetch();
    const [id, note, options] = args as [string, string, unknown];
    await expect(hcp(fetch).createNote(id, note, loose(options))).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  });

  it("does not support listNotes, and sends nothing", async () => {
    const { fetch, calls } = mockFetch();
    const client = hcp(fetch);
    expect(client.capabilities.listNotes).toBe(false);
    await expect(client.listNotes("job_1")).rejects.toBeInstanceOf(CrmUnsupportedError);
    expect(calls).toHaveLength(0);
  });
});
