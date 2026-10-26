import "./_env";
import { providers } from "../src/lib/providers";
import { HttpClient } from "../src/lib/providers/http";

/**
 * Makes the cheapest possible authenticated request to each configured provider.
 * A provider is only reported as working if this request succeeds.
 */
let failures = 0;
for (const p of providers) {
  const cfg = p.configStatus(process.env);
  if (!cfg.configured) {
    console.log(`○ ${p.label}: not configured (missing ${cfg.missing.join(", ")})`);
    continue;
  }
  const http = new HttpClient({ provider: p.name, budget: 5, maxRetries: 1, userAgent: p.userAgent?.(process.env), secrets: p.secrets(process.env) });
  try {
    const msg = await p.check({
      now: new Date(),
      http,
      env: process.env,
      trackedExternalIds: async () => [],
      topicsForInterest: async () => [],
    });
    console.log(`✓ ${p.label}: ${msg}`);
  } catch (err) {
    failures++;
    console.log(`✕ ${p.label}: ${http.redact((err as Error).message)}`);
  }
}
process.exit(failures ? 1 : 0);
