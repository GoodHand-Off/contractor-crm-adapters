import { describe, expect, it } from "vitest";
import {
  AccuLynxClient,
  CRM_PROVIDERS,
  HousecallProClient,
  JobNimbusClient,
  createCrmClient,
  isCrmProviderName,
} from "../src/index.js";
import { TEST_API_KEY, mockFetch } from "./helpers.js";

describe("registry", () => {
  it("creates the right client by name", () => {
    const { fetch } = mockFetch();
    expect(createCrmClient("jobnimbus", { apiKey: TEST_API_KEY, fetch })).toBeInstanceOf(JobNimbusClient);
    expect(createCrmClient("acculynx", { apiKey: TEST_API_KEY, fetch })).toBeInstanceOf(AccuLynxClient);
    expect(createCrmClient("housecallpro", { apiKey: TEST_API_KEY, fetch })).toBeInstanceOf(HousecallProClient);
  });

  it("rejects unknown providers", () => {
    expect(() => createCrmClient("other" as never, { apiKey: TEST_API_KEY })).toThrow("Unknown CRM provider");
    expect(isCrmProviderName("jobnimbus")).toBe(true);
    expect(isCrmProviderName("housecallpro")).toBe(true);
    expect(isCrmProviderName("toString")).toBe(false);
    expect(isCrmProviderName(42)).toBe(false);
  });

  it("describes each provider's capabilities", () => {
    expect(CRM_PROVIDERS.jobnimbus.capabilities.createJob).toBe(true);
    expect(CRM_PROVIDERS.acculynx.capabilities.createJob).toBe(false);
    expect(CRM_PROVIDERS.acculynx.displayName).toBe("AccuLynx");
    expect(CRM_PROVIDERS.housecallpro).toMatchObject({
      displayName: "Housecall Pro",
      capabilities: { listContacts: true, createContact: true, createJob: true, createNote: true, listNotes: false },
    });
    expect(Object.isFrozen(CRM_PROVIDERS.housecallpro.capabilities)).toBe(true);
  });
});
