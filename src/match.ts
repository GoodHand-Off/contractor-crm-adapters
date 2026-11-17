import type { CrmAssignedRep } from "./types.js";

/** A person in your own system that a CRM sales rep might correspond to. */
export interface RepCandidate<Id> {
  /** Your own identifier for the person, returned on a match. */
  id: Id;
  /** Full display name, e.g. "Jordan Avery" or "Avery, Jordan". */
  name: string;
  /** Email address, matched when the CRM rep name is itself an email. */
  email?: string | undefined;
}

/**
 * Collect the distinct sales reps referenced by a set of contacts, keeping the
 * first name seen for each ID.
 */
export function collectAssignedReps(contacts: ReadonlyArray<{ assignedReps: ReadonlyArray<CrmAssignedRep> }>): CrmAssignedRep[] {
  const reps = new Map<string, CrmAssignedRep>();
  for (const contact of contacts) {
    for (const rep of contact.assignedReps) {
      const externalId = rep.externalId.trim();
      if (!externalId) continue;
      const name = rep.name?.trim();
      const known = reps.get(externalId);
      if (!known) reps.set(externalId, name ? { externalId, name } : { externalId });
      else if (!known.name && name) known.name = name;
    }
  }
  return [...reps.values()];
}

const AMBIGUOUS = Symbol("ambiguous");

/**
 * Build a matcher that maps a CRM rep name to one of your users. It never
 * guesses: a name, first name or email that two different candidates share
 * matches nobody.
 *
 * In order:
 * 1. If the CRM name contains "@", it is matched against candidate emails only.
 * 2. A single-word CRM name ("Jordan") against candidates' first names only; a
 *    one-word candidate name counts as a first name.
 * 3. The exact full name ("Jordan Avery"; "Avery, Jordan" is read as "Jordan Avery").
 * 4. A two-word name reversed ("Avery Jordan").
 *
 * Matching ignores case, accents and extra spaces.
 *
 * @returns A function that returns the matched candidate's `id`, or `undefined`.
 */
export function createRepMatcher<Id>(
  candidates: ReadonlyArray<RepCandidate<Id>>,
): (crmName: string | undefined) => Id | undefined {
  const byName = new Map<string, Id | typeof AMBIGUOUS>();
  const byFirstName = new Map<string, Id | typeof AMBIGUOUS>();
  const byEmail = new Map<string, Id | typeof AMBIGUOUS>();
  const add = (map: Map<string, Id | typeof AMBIGUOUS>, key: string, id: Id) => {
    if (!key) return;
    const existing = map.get(key);
    map.set(key, existing === undefined || existing === id ? id : AMBIGUOUS);
  };
  for (const candidate of candidates) {
    const name = normalizeName(candidate.name);
    add(byName, name, candidate.id);
    add(byFirstName, name.split(" ")[0] ?? "", candidate.id);
    if (candidate.email) add(byEmail, candidate.email.trim().toLowerCase(), candidate.id);
  }
  const found = (value: Id | typeof AMBIGUOUS | undefined): Id | undefined => (value === AMBIGUOUS ? undefined : value);

  return (crmName) => {
    if (typeof crmName !== "string" || !crmName.trim()) return undefined;
    if (crmName.includes("@")) return found(byEmail.get(crmName.trim().toLowerCase()));

    const name = normalizeName(crmName);
    const parts = name.split(" ");
    // A one-word name is compared with first names only, so "Kim" is ambiguous when users "Kim" and "Kim Ode" both exist.
    if (parts.length === 1) return found(byFirstName.get(name));
    if (byName.has(name)) return found(byName.get(name));
    if (parts.length === 2) {
      const reversed = `${parts[1]} ${parts[0]}`;
      if (byName.has(reversed)) return found(byName.get(reversed));
    }
    return undefined;
  };
}

/** Lower case, accents removed, spaces collapsed, "Last, First" turned into "first last". */
function normalizeName(value: string): string {
  const folded = value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const comma = /^([^,]+),\s*([^,]+)$/.exec(folded);
  return comma?.[1] && comma[2] ? `${comma[2].trim()} ${comma[1].trim()}` : folded;
}
