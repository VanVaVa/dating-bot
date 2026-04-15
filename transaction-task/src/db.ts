import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL ??
  "postgres://store:store@localhost:5432/store";

export const pool = new Pool({ connectionString });
