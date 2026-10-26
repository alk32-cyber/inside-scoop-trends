import "./_env";
import { getDb } from "../src/lib/db";
import { clearDemo } from "../src/lib/demo/seed";

const db = await getDb();
await clearDemo(db);
console.log("Removed all demo rows (is_demo = true). Live data was not touched.");
await db.close();
