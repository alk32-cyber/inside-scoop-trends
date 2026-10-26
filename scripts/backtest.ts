import "./_env";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../src/lib/db";
import { loadScoringConfig } from "../src/lib/config";
import { runBacktest } from "../src/lib/backtest";

/**
 * npm run backtest                  # live data
 * npm run backtest -- --demo        # simulated demo data
 * Options: --step=6 (hours between cutoffs) --horizon=24 (hours) --k=5
 */
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")) as Array<[string, string | undefined]>);
const db = await getDb();
const report = await runBacktest(db, loadScoringConfig(), {
  isDemo: "demo" in args,
  stepHours: args.step ? Number(args.step) : undefined,
  horizonHours: args.horizon ? Number(args.horizon) : undefined,
  k: args.k ? Number(args.k) : undefined,
});
const fmt = (m: { spearman: number | null; precisionAtK: number | null; baselinePrecisionAtK: number | null; cutoffs: number }) =>
  `spearman=${m.spearman ?? "n/a"}  precision@${report.k}=${m.precisionAtK ?? "n/a"}  popularity-baseline@${report.k}=${m.baselinePrecisionAtK ?? "n/a"}  (${m.cutoffs} cutoffs)`;
console.log(`Backtest on ${report.dataMode.toUpperCase()} data, horizon ${report.horizonHours}h`);
console.log(`Default weights ${JSON.stringify(report.defaultWeights)}\n  ${fmt(report.defaultMetrics)}`);
if (report.tuning) {
  console.log(`Tuned on ${report.tuning.trainCutoffs} cutoffs, tested on ${report.tuning.testCutoffs}:`);
  console.log(`  best weights ${JSON.stringify(report.tuning.bestWeights)}`);
  console.log(`  test (tuned)   ${fmt(report.tuning.testMetrics)}`);
  console.log(`  test (default) ${fmt(report.tuning.defaultTestMetrics)}`);
  console.log(`  → ${report.tuning.recommendation}`);
}
for (const n of report.notes) console.log(`note: ${n}`);
const out = path.join(process.cwd(), ".data", `backtest-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`Report written to ${out}`);
await db.close();
