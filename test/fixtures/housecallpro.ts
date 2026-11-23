/**
 * Synthetic Housecall Pro records. Every name, email, phone number, address
 * and ID here is invented; field names follow the public API documentation
 * for GET /customers and GET /customers/{customer_id}/addresses.
 */
export function hcpCustomer(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = String(n).padStart(5, "0");
  return {
    id: `cus_fixture${id}`,
    first_name: "Pat",
    last_name: `Fixture${id}`,
    created_at: "2026-01-02T15:04:05Z",
    updated_at: "2026-01-03T15:04:05Z",
    tags: [],
    addresses: [],
    ...overrides,
  };
}

export function hcpAddress(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `adr_fixture${String(n).padStart(5, "0")}`,
    type: "service",
    street: `${n} Fixture Row`,
    street_line_2: null,
    city: "Testville",
    state: "ZZ",
    zip: "00000",
    country: "US",
    ...overrides,
  };
}

export const fullCustomer = hcpCustomer(1, {
  first_name: "Pat",
  last_name: "Example",
  email: " pat@example.com ",
  mobile_number: null,
  home_number: "555-555-0101",
  work_number: "555-555-0103",
  company: "Example Holdings",
  notifications_enabled: true,
  lead_source: "Door Knock",
  notes: "Prefers texts after 5 PM.",
  company_name: "Fixture Roofing Co",
  company_id: "company-fixture",
  tags: ["storm", " ", "canvassing"],
  addresses: [
    hcpAddress(9, { type: "billing", street: "9 Billing Lane" }),
    hcpAddress(1, { street_line_2: "Unit B" }),
  ],
});
