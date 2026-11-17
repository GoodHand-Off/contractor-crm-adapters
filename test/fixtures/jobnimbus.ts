/**
 * Synthetic JobNimbus records. Every name, email, phone number, address and ID
 * here is invented; field names follow the public api1 documentation.
 */
export function jnContact(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = String(n).padStart(5, "0");
  return {
    jnid: `jn-contact-${id}`,
    first_name: "Pat",
    last_name: `Fixture${id}`,
    is_active: true,
    date_created: 1_700_000_000 + n,
    date_updated: 1_700_100_000 + n,
    ...overrides,
  };
}

export const fullContact = {
  jnid: "jn-contact-full",
  display_name: "Pat Example",
  first_name: "Pat",
  last_name: "Example",
  company: "Example Holdings",
  email: "pat@example.com",
  home_phone: "555-555-0101",
  mobile_phone: "555-555-0102",
  work_phone: "555-555-0103",
  address_line1: "1 Fixture Row",
  address_line2: "Unit B",
  city: "Testville",
  state_text: "ZZ",
  zip: "00000",
  country_name: "United States",
  sales_rep: "jn-user-rep1",
  sales_rep_name: "Jordan Avery",
  owners: [{ id: "jn-user-rep1" }, { id: "jn-user-rep2" }],
  status_name: "Lead",
  record_type_name: "Customer",
  source_name: "Door Knock",
  tags: "storm, priority",
  is_active: true,
  is_archived: false,
  date_start: 1_700_200_000,
  date_created: 1_700_000_000,
  date_updated: 1_700_100_000,
  description: "Synthetic test record.",
  // Custom fields, as the docs show them: top-level, by label or by system name.
  "Insurance Carrier": "Sample Mutual",
  "Estimate Total": "$12,500.00",
  cf_date_1: 1_550_692_800,
  cf_string_1: "Two-story, steep pitch",
};
