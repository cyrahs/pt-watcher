import { migrate } from "drizzle-orm/bun-sql/migrator";
import { db } from "./index";

export async function runMigrations() {
  await migrate(db, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
}
