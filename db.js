// db.js
import dotenv from "dotenv";
import pkg from "pg";

dotenv.config();

const { Pool } = pkg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function sql(strings, ...params) {
  const client = await pool.connect();
  try {
    const text = strings.reduce(
      (acc, str, i) => acc + str + (params[i] !== undefined ? `$${i + 1}` : ""),
      ""
    );

    const result = await client.query(text, params);
    return result.rows;
  } finally {
    client.release();
  }
}
