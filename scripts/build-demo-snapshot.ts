import "./_env";
import fs from "node:fs";
import path from "node:path";
import { DEMO_SNAPSHOT_PATH, exportDemoSnapshot, migrate, openDb } from "../src/lib/db";
import { seedDemo } from "../src/lib/demo/seed";

/**
 * Builds demo/demo-snapshot.json.gz from a fresh in-memory database containing ONLY simulated
 * demo data. Deployments without DATABASE_URL load it into memory when DEMO_MODE=true.
 */
const db = await openDb({ inMemory: true });
await migrate(db);
const res = await seedDemo(db);
const gz = await exportDemoSnapshot(db);
fs.mkdirSync(path.dirname(DEMO_SNAPSHOT_PATH), { recursive: true });
fs.writeFileSync(DEMO_SNAPSHOT_PATH, gz);
console.log(`Wrote ${DEMO_SNAPSHOT_PATH} (${(gz.length / 1024).toFixed(0)} KB): ${res.items} simulated items, ${res.topics} topics.`);
await db.close();
