import type { CrmProviderName } from "./types.js";

/** Display names, and where each vendor documents creating an API key (checked 2026-11-17; Housecall Pro 2026-11-23). */
export const PROVIDER_INFO: Readonly<Record<CrmProviderName, { displayName: string; keyHelp: string }>> = {
  jobnimbus: {
    displayName: "JobNimbus",
    keyHelp:
      "Create a key in JobNimbus under Settings > API > New API key (https://documenter.getpostman.com/view/3919598/S11PpG4x).",
  },
  acculynx: {
    displayName: "AccuLynx",
    keyHelp: "Create and name an API key in the AccuLynx account (https://apidocs.acculynx.com/docs/getting-started).",
  },
  housecallpro: {
    displayName: "Housecall Pro",
    keyHelp:
      "An Admin on a MAX plan account creates a key in Housecall Pro under My Apps > All Apps > API Key Management > " +
      "Generate API Key; choose Full access to create records (https://help.housecallpro.com/en/articles/8505035-api-overview).",
  },
};
