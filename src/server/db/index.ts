import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://ptwatcher:ptwatcher@localhost:5432/ptwatcher";

const client = new SQL(databaseUrl);

export const db = drizzle({ client, schema });
export { schema };
