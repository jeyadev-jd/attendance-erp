import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Defaults are sufficient for the free tier: no incremental cache or R2 wiring
// is needed until ISR / on-demand revalidation is introduced.
export default defineCloudflareConfig({});
