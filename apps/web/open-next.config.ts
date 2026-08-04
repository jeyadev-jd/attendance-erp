import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({
  // Defaults are sufficient for the free tier: no incremental cache / R2 wiring
  // needed until ISR or on-demand revalidation is introduced.
});
