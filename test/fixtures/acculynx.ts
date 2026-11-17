/**
 * Synthetic AccuLynx jobs. Every value is invented; field names follow the
 * public v2 OpenAPI documentation for GET /jobs with includes=contact.
 */
export function alJob(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return {
    id,
    jobName: `Fixture Job ${n}`,
    currentMilestone: "Lead",
    createdDate: "2026-01-02T15:04:05Z",
    modifiedDate: "2026-01-03T15:04:05Z",
    contacts: [],
    ...overrides,
  };
}

export const fullJob = alJob(1, {
  jobNumber: "J-0001",
  currentMilestone: "Approved",
  locationAddress: {
    street1: "1 Fixture Row",
    street2: "Unit B",
    city: "Testville",
    state: { id: 1, name: "Test State", abbreviation: "ZZ" },
    zipCode: "00000",
    country: { id: 1, name: "United States", abbreviation: "US" },
  },
  tradeTypes: [{ tradeId: "t1", name: "Roofing" }, { tradeId: "t2", name: "Gutters" }],
  workType: { id: 3, name: "Insurance" },
  leadSource: { id: "ls1", name: "Door Knock", children: [] },
  contacts: [
    {
      id: "jc-2",
      isPrimary: false,
      relationToPrimary: "Spouse",
      contact: { id: "c-2", firstName: "Sam", lastName: "Example" },
    },
    {
      id: "jc-1",
      isPrimary: true,
      contact: {
        id: "c-1",
        firstName: "Pat",
        lastName: "Example",
        companyName: "",
        phoneNumbers: [{ id: "p-1", _link: "https://example.com/p-1" }],
        emailAddresses: [{ id: "e-1", _link: "https://example.com/e-1" }],
      },
    },
  ],
});
