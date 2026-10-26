import "./_env";
import { migrate, openDb } from "../src/lib/db";

const db = await openDb();
const ran = await migrate(db);
console.log(ran.length ? `Applied: ${ran.join(", ")}` : "Database is up to date.");
await db.close();
