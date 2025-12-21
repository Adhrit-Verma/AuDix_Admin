import pg from "pg";
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render Postgres requires SSL
  ssl: { rejectUnauthorized: false }
});

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS flat_requests (
      id BIGSERIAL PRIMARY KEY,
      flat_id TEXT NOT NULL,
      name TEXT NOT NULL,
      note TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS flats (
      flat_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      pin_hash TEXT,
      password_hash TEXT,
      strike_count INT NOT NULL DEFAULT 0,
      ban_until BIGINT,
      requires_admin_revoke BOOLEAN NOT NULL DEFAULT FALSE,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      last_login_at BIGINT
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS setup_codes (
      id BIGSERIAL PRIMARY KEY,
      flat_id TEXT NOT NULL REFERENCES flats(flat_id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      used_at BIGINT,
      created_at BIGINT NOT NULL
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS admin_audit (
      id BIGSERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      meta_json TEXT,
      created_at BIGINT NOT NULL
    );
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_flat_requests_status ON flat_requests(status);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_setup_codes_flat_id ON setup_codes(flat_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_setup_codes_expires ON setup_codes(expires_at);`);
}
