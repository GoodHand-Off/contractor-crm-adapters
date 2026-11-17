import { describe, expect, it } from "vitest";
import { collectAssignedReps, createRepMatcher } from "../src/index.js";

const match = createRepMatcher([
  { id: "u1", name: "Jordan Avery", email: "jordan@example.com" },
  { id: "u2", name: "Casey Quinn" },
  { id: "u3", name: "Casey Morgan" },
  { id: "u4", name: "Riley" },
  { id: "u5", name: "José Peña" },
  { id: "u6", name: "Sam Example", email: "shared@example.com" },
  { id: "u7", name: "Sam Example", email: "shared@example.com" },
]);

describe("createRepMatcher", () => {
  it("matches the exact name, ignoring case, accents and spacing", () => {
    expect(match("  jordan   AVERY ")).toBe("u1");
    expect(match("Jose Pena")).toBe("u5");
  });

  it("reads 'Last, First' and a reversed two-word name", () => {
    expect(match("Avery, Jordan")).toBe("u1");
    expect(match("Avery Jordan")).toBe("u1");
    expect(createRepMatcher([{ id: "x", name: "Avery, Jordan" }])("Jordan Avery")).toBe("x");
  });

  it("uses the first name only for a single-word CRM name, and only when unique", () => {
    expect(match("Jordan")).toBe("u1");
    expect(match("Riley")).toBe("u4");
    expect(match("Casey")).toBeUndefined();
  });

  it("never matches a different surname through the first name", () => {
    expect(match("Jordan Smith")).toBeUndefined();
    expect(match("Riley Smithfield")).toBeUndefined();
  });

  it("treats a name or email two candidates share as unmatchable", () => {
    expect(match("Sam Example")).toBeUndefined();
    expect(match("shared@example.com")).toBeUndefined();
    expect(match("Sam")).toBeUndefined();
  });

  it("treats a one-word name as ambiguous when it is also another user's first name", () => {
    const kims = createRepMatcher([
      { id: "k1", name: "Kim" },
      { id: "k2", name: "Kim Ode" },
    ]);
    expect(kims("Kim")).toBeUndefined();
    expect(kims("Kim Ode")).toBe("k2");
    expect(createRepMatcher([{ id: "k1", name: "Kim" }])("kim")).toBe("k1");
  });

  it("does not count the same candidate listed twice as ambiguous", () => {
    const same = createRepMatcher([
      { id: "u1", name: "Jordan Avery" },
      { id: "u1", name: "Jordan Avery" },
    ]);
    expect(same("Jordan Avery")).toBe("u1");
  });

  it("matches an email address, case-insensitively", () => {
    expect(match("Jordan@Example.com")).toBe("u1");
    expect(match("nobody@example.com")).toBeUndefined();
  });

  it("returns undefined for blank, missing or unknown names", () => {
    expect(match("")).toBeUndefined();
    expect(match(undefined)).toBeUndefined();
    expect(match("Taylor Unknown")).toBeUndefined();
  });
});

describe("collectAssignedReps", () => {
  it("returns distinct reps and keeps the first name seen", () => {
    const reps = collectAssignedReps([
      { assignedReps: [{ externalId: "r1" }, { externalId: "r2", name: "Casey Quinn" }] },
      { assignedReps: [{ externalId: "r1", name: "Jordan Avery" }, { externalId: " " }] },
      { assignedReps: [{ externalId: "r1", name: "Someone Else" }] },
    ]);
    expect(reps).toEqual([
      { externalId: "r1", name: "Jordan Avery" },
      { externalId: "r2", name: "Casey Quinn" },
    ]);
  });
});
