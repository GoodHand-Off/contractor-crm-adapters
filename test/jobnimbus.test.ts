import { describe, expect, it } from "vitest";
import { CrmResponseError, CrmValidationError, JobNimbusClient } from "../src/index.js";
import { fullContact, jnContact } from "./fixtures/jobnimbus.js";
import { TEST_API_KEY, filterOf, json, mockFetch } from "./helpers.js";

function jn(fetch: typeof globalThis.fetch) {
  return new JobNimbusClient({ apiKey: TEST_API_KEY, fetch });
}

function page(start: number, count: number) {
  return json({ count: 99_999, results: Array.from({ length: count }, (_, i) => jnContact(start + i)) });
}

const ACTIVE = { term: { is_active: true } };

describe("JobNimbus testConnection", () => {
  it("reads one contact id from the documented base URL", async () => {
    const { fetch, calls } = mockFetch(json({ count: 1, results: [] }));
    await jn(fetch).testConnection();
    expect(String(calls[0]?.url).split("?")[0]).toBe("https://app.jobnimbus.com/api1/contacts");
    expect(calls[0]?.url.searchParams.get("size")).toBe("1");
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TEST_API_KEY}`);
  });
});

describe("JobNimbus iterateContacts", () => {
  it("pages with size/from, oldest first, active records only, and stops on a short page", async () => {
    const { fetch, calls } = mockFetch(page(0, 3), page(3, 3), page(6, 1));
    const { contacts, truncated } = await jn(fetch).listContacts({ pageSize: 3 });

    expect(contacts).toHaveLength(7);
    expect(truncated).toBe(false);
    expect(calls.map((c) => c.url.searchParams.get("from"))).toEqual(["0", "3", "6"]);
    for (const call of calls) {
      expect(call.url.searchParams.get("size")).toBe("3");
      expect(call.url.searchParams.get("sort_field")).toBe("date_created");
      expect(call.url.searchParams.get("sort_direction")).toBe("asc");
      expect(filterOf(call)).toEqual({ must: [ACTIVE] });
      expect(call.url.searchParams.has("limit")).toBe(false);
      expect(call.url.searchParams.has("offset")).toBe(false);
    }
  });

  it("drops deleted records client-side even if the server filter lets one through", async () => {
    const { fetch } = mockFetch(json({ results: [jnContact(1, { is_active: false }), jnContact(2)] }));
    const { contacts } = await jn(fetch).listContacts();
    expect(contacts.map((c) => c.externalId)).toEqual(["jn-contact-00002"]);
    expect(contacts[0]?.deleted).toBeUndefined();
  });

  it("includes deleted records only when asked, and flags them", async () => {
    const { fetch, calls } = mockFetch(json({ results: [jnContact(1, { is_active: false, is_archived: true })] }));
    const { contacts } = await jn(fetch).listContacts({ includeDeleted: true });
    expect(filterOf(calls[0])).toBeUndefined();
    expect(contacts[0]).toMatchObject({ deleted: true, archived: true });
  });

  it("defaults to 500 per page and clamps to the documented maximum of 1000", async () => {
    const first = mockFetch(json({ results: [] }));
    await jn(first.fetch).listContacts();
    expect(first.calls[0]?.url.searchParams.get("size")).toBe("500");

    const second = mockFetch(json({ results: [] }));
    await jn(second.fetch).listContacts({ pageSize: 5000 });
    expect(second.calls[0]?.url.searchParams.get("size")).toBe("1000");
  });

  it("starts a date_created window past 10,000 records and drops duplicates", async () => {
    // Ten full pages of 1000 fill the 10,000-record window.
    const replies = Array.from({ length: 10 }, (_, i) => page(i * 1000, 1000));
    // The next query restarts at the last date_created seen (record 9999), so it
    // returns record 9999 again, then two new ones.
    replies.push(json({ results: [jnContact(9999), jnContact(10_000), jnContact(10_001)] }));
    const { fetch, calls } = mockFetch(...replies);

    const { contacts } = await jn(fetch).listContacts({ pageSize: 1000 });

    expect(contacts).toHaveLength(10_002);
    expect(new Set(contacts.map((c) => c.externalId)).size).toBe(10_002);
    expect(calls).toHaveLength(11);
    expect(calls[9]?.url.searchParams.get("from")).toBe("9000");
    expect(filterOf(calls[9])).toEqual({ must: [ACTIVE] });
    expect(calls[10]?.url.searchParams.get("from")).toBe("0");
    expect(filterOf(calls[10])).toEqual({ must: [ACTIVE, { range: { date_created: { gte: 1_700_009_999 } } }] });
  });

  it("refuses to loop when over 10,000 records share one date_created", async () => {
    const same = (start: number) =>
      json({ results: Array.from({ length: 1000 }, (_, i) => jnContact(start + i, { date_created: 1_700_000_000 })) });
    const replies = Array.from({ length: 10 }, (_, i) => same(i * 1000));
    replies.push(...Array.from({ length: 10 }, (_, i) => same(10_000 + i * 1000)));
    const { fetch } = mockFetch(...replies);

    await expect(jn(fetch).listContacts({ pageSize: 1000 })).rejects.toBeInstanceOf(CrmResponseError);
  });

  it("reports truncation when it stops at maxRecords with more records left", async () => {
    const { fetch, calls } = mockFetch(page(0, 3));
    const { contacts, truncated } = await jn(fetch).listContacts({ pageSize: 3, maxRecords: 2 });
    expect(contacts).toHaveLength(2);
    expect(truncated).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("does not report truncation when the cap lands on the last record", async () => {
    const { fetch } = mockFetch(json({ results: [jnContact(1), jnContact(2)] }));
    await expect(jn(fetch).listContacts({ pageSize: 3, maxRecords: 2 })).resolves.toMatchObject({ truncated: false });
  });

  it("returns the truncation flag as the generator's result", async () => {
    const { fetch } = mockFetch(page(0, 3));
    const generator = jn(fetch).iterateContacts({ pageSize: 3, maxRecords: 1 });
    expect((await generator.next()).done).toBe(false);
    await expect(generator.next()).resolves.toEqual({ done: true, value: { truncated: true } });
  });

  it("skips records without a jnid", async () => {
    const { fetch } = mockFetch(json({ results: [{ first_name: "No Id" }, jnContact(1)] }));
    const { contacts } = await jn(fetch).listContacts();
    expect(contacts.map((c) => c.externalId)).toEqual(["jn-contact-00001"]);
  });

  it.each([[{ results: "nope" }], [{ count: 0 }], [undefined]])(
    "throws CrmResponseError when a 200 has no results array (%o)",
    async (body) => {
      const { fetch } = mockFetch(body === undefined ? new Response("", { status: 200 }) : json(body));
      await expect(jn(fetch).listContacts()).rejects.toThrow(/no "results" array/);
    },
  );

  it("maps the documented contact fields", async () => {
    const { fetch } = mockFetch(json({ results: [fullContact] }));
    const { contacts } = await jn(fetch).listContacts();

    expect(contacts[0]).toEqual({
      externalId: "jn-contact-full",
      name: "Pat Example",
      firstName: "Pat",
      lastName: "Example",
      email: "pat@example.com",
      phone: "555-555-0102",
      address: { street: "1 Fixture Row, Unit B", city: "Testville", state: "ZZ", zip: "00000", country: "United States" },
      assignedReps: [{ externalId: "jn-user-rep1", name: "Jordan Avery" }, { externalId: "jn-user-rep2" }],
      tags: ["storm", "priority"],
      status: "Lead",
      jobContext: {
        projectType: "Customer",
        milestone: "Lead",
        leadSource: "Door Knock",
        appointmentDate: 1_700_200_000_000,
        lastActivityAt: 1_700_100_000_000,
        rawSummary: "Synthetic test record.",
      },
    });
  });

  it("fills job context from documented top-level custom fields, by label or system name", async () => {
    const { fetch } = mockFetch(json({ results: [fullContact] }));
    const { contacts } = await jn(fetch).listContacts({
      customFieldMappings: {
        insuranceContext: "insurance_carrier",
        estimateValue: "estimate-total",
        appointmentDate: "cf_date_1",
        roofDetails: "CF String 1",
        propertyDetails: "Missing",
      },
    });
    expect(contacts[0]?.jobContext).toMatchObject({
      insuranceContext: "Sample Mutual",
      estimateValue: 12_500,
      appointmentDate: 1_550_692_800_000,
      roofDetails: "Two-story, steep pitch",
    });
    expect(contacts[0]?.jobContext?.propertyDetails).toBeUndefined();
  });

  it("falls back to company for the name and accepts tags as an array", async () => {
    const { fetch } = mockFetch(json({ results: [{ jnid: "jn-c", company: "Example Holdings", tags: ["a", " ", "b"] }] }));
    const { contacts } = await jn(fetch).listContacts();
    expect(contacts[0]?.name).toBe("Example Holdings");
    expect(contacts[0]?.tags).toEqual(["a", "b"]);
    expect(contacts[0]?.assignedReps).toEqual([]);
    expect(contacts[0]?.address).toBeUndefined();
  });
});

describe("JobNimbus createContact", () => {
  it("posts documented field names and the skip parameter", async () => {
    const { fetch, calls } = mockFetch(json({ jnid: "jn-new-1" }));
    const result = await jn(fetch).createContact({
      firstName: " Pat ",
      lastName: "Example",
      email: "pat@example.com",
      phone: "555-555-0102",
      recordTypeName: "Customer",
      statusName: "Lead",
      sourceName: "Door Knock",
      address: { street: "1 Fixture Row", city: "Testville", state: "ZZ", zip: "00000", country: "United States" },
      tags: ["storm", "canvassing"],
      description: "Met at the door.",
      assignedRepExternalId: "jn-user-rep1",
      assignedRepName: "Jordan Avery",
      skipAutomation: true,
      skipNotification: true,
    });

    expect(result).toEqual({ externalId: "jn-new-1" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/api1/contacts");
    expect(calls[0]?.url.searchParams.get("skip")).toBe("automation,notification");
    expect(calls[0]?.body).toEqual({
      first_name: "Pat",
      last_name: "Example",
      email: "pat@example.com",
      mobile_phone: "555-555-0102",
      record_type_name: "Customer",
      status_name: "Lead",
      source_name: "Door Knock",
      address_line1: "1 Fixture Row",
      city: "Testville",
      state_text: "ZZ",
      zip: "00000",
      country_name: "United States",
      tags: "storm,canvassing",
      description: "Met at the door.",
      sales_rep: "jn-user-rep1",
      sales_rep_name: "Jordan Avery",
      owners: [{ id: "jn-user-rep1" }],
    });
  });

  it("omits empty fields and the skip parameter when not asked", async () => {
    const { fetch, calls } = mockFetch(json({ jnid: "jn-new-2" }));
    await jn(fetch).createContact({ companyName: "Example Holdings", recordTypeName: "Customer", statusName: "Lead" });
    expect(calls[0]?.url.search).toBe("");
    expect(calls[0]?.body).toEqual({ company: "Example Holdings", record_type_name: "Customer", status_name: "Lead" });
  });

  it.each([
    [{ recordTypeName: "Customer", statusName: "Lead" }, "firstName"],
    [{ firstName: "Pat", recordTypeName: "", statusName: "Lead" }, "recordTypeName"],
    [{ firstName: "Pat", recordTypeName: "Customer", statusName: " " }, "statusName"],
    [{ firstName: "Pat", recordTypeName: "Customer", statusName: "Lead", tags: ["a,b"] }, "commas"],
  ])("rejects invalid input before sending (%o)", async (payload, message) => {
    const { fetch, calls } = mockFetch();
    const error = await jn(fetch).createContact(payload).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CrmValidationError);
    expect((error as Error).message).toContain(message);
    expect(calls).toHaveLength(0);
  });

  it("throws CrmResponseError when the response has no jnid", async () => {
    const { fetch } = mockFetch(json({}));
    await expect(
      jn(fetch).createContact({ firstName: "Pat", recordTypeName: "Customer", statusName: "Lead" }),
    ).rejects.toBeInstanceOf(CrmResponseError);
  });
});

describe("JobNimbus createJob", () => {
  it("links the primary contact with primary.id", async () => {
    const { fetch, calls } = mockFetch(json({ jnid: "jn-job-1" }));
    const result = await jn(fetch).createJob({
      name: "Example roof replacement",
      recordTypeName: "Job",
      statusName: "Lead",
      primaryContactExternalId: "jn-contact-full",
      skipAutomation: true,
    });
    expect(result).toEqual({ externalId: "jn-job-1" });
    expect(calls[0]?.url.pathname).toBe("/api1/jobs");
    expect(calls[0]?.url.searchParams.get("skip")).toBe("automation");
    expect(calls[0]?.body).toEqual({
      name: "Example roof replacement",
      record_type_name: "Job",
      status_name: "Lead",
      primary: { id: "jn-contact-full" },
    });
  });

  it.each([
    [{ name: "", recordTypeName: "Job", statusName: "Lead" }, /name is required/],
    [{ name: "Roof", recordTypeName: " ", statusName: "Lead" }, /recordTypeName is required/],
    [{ name: "Roof", recordTypeName: "Job", statusName: "" }, /statusName is required/],
  ])("rejects %o before sending", async (payload, message) => {
    const { fetch, calls } = mockFetch();
    await expect(jn(fetch).createJob(payload)).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  });

  it("throws CrmResponseError when the response has no jnid", async () => {
    const { fetch } = mockFetch(json({ id: "other" }));
    await expect(jn(fetch).createJob({ name: "Roof", recordTypeName: "Job", statusName: "Lead" })).rejects.toThrow(/no jnid/);
  });
});

describe("JobNimbus notes", () => {
  it("creates a Note activity on the record", async () => {
    const { fetch, calls } = mockFetch(json({ jnid: "jn-act-1" }));
    const result = await jn(fetch).createNote("jn-contact-full", "Coaching summary.", { source: "Example App" });
    expect(result).toEqual({ externalId: "jn-act-1" });
    expect(calls[0]?.url.pathname).toBe("/api1/activities");
    expect(calls[0]?.body).toEqual({
      note: "Coaching summary.",
      record_type_name: "Note",
      primary: { id: "jn-contact-full" },
      source: "Example App",
    });
  });

  it.each([[new Response("", { status: 200 })], [json({})]])("throws CrmResponseError when the response has no jnid", async (reply) => {
    const { fetch } = mockFetch(reply);
    await expect(jn(fetch).createNote("jn-contact-full", "Hi")).rejects.toThrow(/POST \/activities succeeded but the response had no jnid/);
  });

  it("rejects a blank note or record id before sending", async () => {
    const { fetch, calls } = mockFetch();
    await expect(jn(fetch).createNote("jn-contact-full", "  ")).rejects.toBeInstanceOf(CrmValidationError);
    await expect(jn(fetch).createNote(" ", "Hi")).rejects.toThrow(/recordExternalId is required/);
    expect(calls).toHaveLength(0);
  });

  it("lists recent active activities with the documented related.id filter", async () => {
    const { fetch, calls } = mockFetch(
      json({
        count: 3,
        activity: [
          { note: "Second visit booked.", record_type_name: "Note", created_by_name: "Jordan Avery", date_created: 1_700_000_500 },
          { note: "  ", record_type_name: "Note", date_created: 1_700_000_400 },
          { note: "Contact Created", record_type_name: "Contact Created", date_created: 1_700_000_300 },
        ],
      }),
    );
    const notes = await jn(fetch).listNotes("jn-contact-full", { limit: 3 });

    expect(calls[0]?.url.pathname).toBe("/api1/activities");
    expect(calls[0]?.url.searchParams.get("size")).toBe("3");
    expect(calls[0]?.url.searchParams.get("sort_direction")).toBe("desc");
    expect(calls[0]?.url.searchParams.has("related_to")).toBe(false);
    expect(filterOf(calls[0])).toEqual({ must: [{ term: { "related.id": "jn-contact-full" } }, ACTIVE] });
    expect(notes).toEqual([
      { content: "Second visit booked.", author: "Jordan Avery", createdAt: 1_700_000_500_000, type: "Note" },
      { content: "Contact Created", createdAt: 1_700_000_300_000, type: "Contact Created" },
    ]);
  });

  it("drops the active filter with includeDeleted, and flags deleted and archived notes", async () => {
    const { fetch, calls } = mockFetch(
      json({ results: [{ note: "Old", is_active: false, is_archived: true }, { note: "Live", is_active: true, is_archived: false }] }),
    );
    const notes = await jn(fetch).listNotes("jn-1", { includeDeleted: true });
    expect(filterOf(calls[0])).toEqual({ must: [{ term: { "related.id": "jn-1" } }] });
    expect(notes).toEqual([{ content: "Old", archived: true, deleted: true }, { content: "Live" }]);
  });

  it("drops deleted notes client-side even if the server filter lets one through", async () => {
    const { fetch } = mockFetch(json({ results: [{ note: "Old", is_active: false }, { note: "Live" }] }));
    await expect(jn(fetch).listNotes("jn-1")).resolves.toEqual([{ content: "Live" }]);
  });

  it("also reads activities returned under results", async () => {
    const { fetch } = mockFetch(json({ results: [{ note: "Hello", record_type_name: "Note" }] }));
    await expect(jn(fetch).listNotes("jn-contact-full")).resolves.toEqual([{ content: "Hello", type: "Note" }]);
  });

  it("throws CrmResponseError when neither activity nor results is an array", async () => {
    const { fetch } = mockFetch(json({ activity: "nope" }));
    await expect(jn(fetch).listNotes("jn-1")).rejects.toBeInstanceOf(CrmResponseError);
  });
});
