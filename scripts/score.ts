import "./_env";
import { getDb } from "../src/lib/db";
import { scoreAll } from "../src/lib/pipeline/score";
import { isDemoMode } from "../src/lib/api/service";

/** Re-scores without collecting new data (e.g. after changing SCORING_WEIGHTS). */
const db = await getDb();
const demo = process.argv.includes("--demo") || isDemoMode();
const { results } = await scoreAll(db, { isDemo: demo });
console.log(`Scored ${results.length} ${demo ? "DEMO" : "live"} topics.`);
for (const r of results.slice(0, 15)) {
  console.log(`${r.trendScore.toFixed(1).padStart(5)}  conf ${r.confidence.toFixed(0).padStart(3)}  ${r.lifecycle.padEnd(17)} ${r.topicId}${r.flags.length ? `  [${r.flags.join(", ")}]` : ""}`);
}
await db.close();
