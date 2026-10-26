import "./_env";
import { getDb } from "../src/lib/db";
import { runPipeline } from "../src/lib/pipeline/run";

/**
 * Runs the live pipeline once.
 *   npm run ingest                      # providers that are due
 *   npm run ingest -- --force           # all configured providers now
 *   npm run ingest -- --provider=reddit,news
 *   npm run ingest -- --no-analyze      # skip AI analysis
 */
const args = process.argv.slice(2);
const providers = args.find((a) => a.startsWith("--provider="))?.split("=")[1].split(",");
const db = await getDb();
const report = await runPipeline(db, { providers, force: args.includes("--force"), analyze: !args.includes("--no-analyze") });
for (const r of report.runs) {
  console.log(`${r.provider.padEnd(14)} ${r.status.padEnd(8)} fetched=${r.itemsFetched} new=${r.itemsNew} requests=${r.requestsMade}${r.error ? `  — ${r.error}` : ""}`);
}
if (report.runs.length === 0) console.log("No provider was due. Use --force to run anyway.");
console.log(`normalized: ${report.normalized?.itemsScanned ?? 0} items, ${report.normalized?.topicsCreated.length ?? 0} new topics, ${report.normalized?.topicsActivated ?? 0} active`);
console.log(`observations written: ${report.observationsWritten}; topics scored: ${report.scored}; analyses: ${report.analyses.generated} generated`);
await db.close();
