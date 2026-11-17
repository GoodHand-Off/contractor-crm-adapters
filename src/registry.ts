import type { ClientOptions } from "./http.js";
import { PROVIDER_INFO } from "./provider-info.js";
import { ACCULYNX_CAPABILITIES, AccuLynxClient } from "./providers/acculynx.js";
import { JOBNIMBUS_CAPABILITIES, JobNimbusClient } from "./providers/jobnimbus.js";
import type { CrmCapabilities, CrmClient, CrmProviderName } from "./types.js";

/** What a settings screen needs to know about one adapter. */
export interface CrmProviderInfo {
  /** Name to show users, e.g. "JobNimbus". */
  displayName: string;
  /** One sentence telling a user where to create an API key, with the vendor's doc link. */
  keyHelp: string;
  /** What the adapter supports. */
  capabilities: Readonly<CrmCapabilities>;
}

/** Display name, key instructions and capabilities of each adapter, for building settings screens. */
export const CRM_PROVIDERS: Readonly<Record<CrmProviderName, Readonly<CrmProviderInfo>>> = Object.freeze({
  jobnimbus: Object.freeze({ ...PROVIDER_INFO.jobnimbus, capabilities: JOBNIMBUS_CAPABILITIES }),
  acculynx: Object.freeze({ ...PROVIDER_INFO.acculynx, capabilities: ACCULYNX_CAPABILITIES }),
});

/**
 * Create a client for a provider chosen at runtime, for example from a saved integration.
 *
 * @param provider - `"jobnimbus"` or `"acculynx"`. Narrow untrusted strings with {@link isCrmProviderName} first.
 * @param options - API key and optional transport settings.
 * @throws TypeError for an unknown provider name.
 * @throws {@link CrmValidationError} if the key is missing or an option is out of range.
 */
export function createCrmClient(provider: CrmProviderName, options: ClientOptions): CrmClient {
  switch (provider) {
    case "jobnimbus":
      return new JobNimbusClient(options);
    case "acculynx":
      return new AccuLynxClient(options);
    default:
      throw new TypeError(
        `Unknown CRM provider "${String(provider satisfies never)}"; expected one of: ${Object.keys(CRM_PROVIDERS).join(", ")}`,
      );
  }
}

/**
 * Narrow an arbitrary value (from a database row or a form) to a supported provider name.
 *
 * @returns `true` for `"jobnimbus"` and `"acculynx"`, `false` for anything else.
 */
export function isCrmProviderName(value: unknown): value is CrmProviderName {
  return typeof value === "string" && Object.hasOwn(CRM_PROVIDERS, value);
}
