import "./_env";
import { getDb } from "../src/lib/db";
import { runPipeline } from "../src/lib/pipeline/run";

/**
 * Long-running scheduler for self-hosting (a VM, Railway, Fly, a home server).
 * Every TICK_MINUTES it runs whichever providers are due per their own interval
 * (YOUTUBE_INTERVAL_MINUTES etc.), then normalizes and re-scores. On Vercel, use the
 * cron route instead (see vercel.json).
 */
const tickMinutes = Number(process.env.SCHEDULER_TICK_MINUTES ?? 10);
const db = await getDb();
let running = false;

async function tick() {
  if (running) return;
  running = true;
  const started = new Date();
  try {
    const report = await runPipeline(db, {});
    const ran = report.runs.map((r) => `${r.provider}:${r.status}`).join(" ") || "no providers due";
    console.log(`[${started.toISOString()}] ${ran}; scored ${report.scored}`);
  } catch (err) {
    console.error(`[${started.toISOString()}] pipeline failed:`, (err as Error).message);
  } finally {
    running = false;
  }
}

console.log(`Scheduler started (tick every ${tickMinutes} min, times in UTC).`);
await tick();
const timer = setInterval(tick, tickMinutes * 60_000);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    clearInterval(timer);
    await db.close();
    process.exit(0);
  });
}
