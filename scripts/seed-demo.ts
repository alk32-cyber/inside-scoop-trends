import "./_env";
import { getDb } from "../src/lib/db";
import { seedDemo } from "../src/lib/demo/seed";

const db = await getDb();
const started = Date.now();
const res = await seedDemo(db);
console.log(`Seeded DEMO data (simulated, is_demo=true): ${res.items} items, ${res.topics} active topics in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
console.log("Set DEMO_MODE=true to show it in the dashboard. Remove it with `npm run demo:clear`.");
await db.close();
