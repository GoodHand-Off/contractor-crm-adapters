import type { CrmProviderName } from "./types.js";

/** Display names, and where each vendor documents creating an API key (checked 2026-11-17). */
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
};
