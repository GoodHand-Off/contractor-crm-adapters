import { CrmValidationError } from "./errors.js";
import { PROVIDER_INFO } from "./provider-info.js";
import type { CrmProviderName } from "./types.js";

/** Throw a {@link CrmValidationError} whose message starts with the provider's display name. */
export function invalid(provider: CrmProviderName, message: string): never {
  throw new CrmValidationError(provider, `${PROVIDER_INFO[provider].displayName}: ${message}`);
}

/** `undefined` passes; anything else must be a string. Returns the trimmed value, or `undefined` if blank. */
export function optionalString(provider: CrmProviderName, value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") invalid(provider, `${name} must be a string`);
  return value.trim() || undefined;
}

/** Must be a non-blank string. Returns it trimmed. */
export function requiredString(provider: CrmProviderName, value: unknown, name: string): string {
  const text = optionalString(provider, value, name);
  if (text === undefined) invalid(provider, `${name} is required`);
  return text;
}

/** `undefined` passes; anything else must be an array of strings. Blank entries are dropped. */
export function optionalStringArray(provider: CrmProviderName, value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    invalid(provider, `${name} must be an array of strings`);
  }
  return (value as string[]).map((item) => item.trim()).filter(Boolean);
}

/** `undefined` passes; anything else must be a plain object. */
export function optionalObject(provider: CrmProviderName, value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) invalid(provider, `${name} must be an object`);
  return value as Record<string, unknown>;
}

/** `undefined` returns `fallback`; anything else must be a finite number within the bounds (and whole, if `integer`). */
export function numberOption(
  provider: CrmProviderName,
  value: unknown,
  name: string,
  rule: { fallback: number; min: number; max?: number; integer?: boolean },
): number {
  if (value === undefined) return rule.fallback;
  const ok =
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= rule.min &&
    (rule.max === undefined || value <= rule.max) &&
    (!rule.integer || Number.isInteger(value));
  if (!ok) {
    const range = rule.max === undefined ? `>= ${rule.min}` : `from ${rule.min} to ${rule.max}`;
    invalid(provider, `${name} must be ${rule.integer ? "a whole number" : "a number"} ${range}`);
  }
  return value as number;
}

/** `undefined` passes; anything else must be a boolean. */
export function optionalBoolean(provider: CrmProviderName, value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") invalid(provider, `${name} must be true or false`);
  return value;
}
