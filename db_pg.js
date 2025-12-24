import pg from "pg";
const { Pool } = pg;

function normalizeDatabaseUrl(raw) {
  if (!raw) throw new Error("Missing DATABASE_URL");

  // Support both DATABASE_URL and DATABASE_URI just in case (optional)
  const u = new URL(raw);

  // If this is Supabase pooler and port is mistakenly 5432, force 6543.
  // (Supabase pooler is commonly 6543; direct is 5432.)
  const host = u.hostname || "";
  const isSupabasePooler = host.includes(".pooler.supabase.com");
  if (isSupabasePooler) {
    const port = u.port ? Number(u.port) : 5432;
    if (port === 5432) {
      u.port = "6543";
    }
    // ensure sslmode=require
    if (!u.searchParams.get("sslmode")) {
      u.searchParams.set("sslmode", "require");
    }
  }

  return u.toString();
}

const DATABASE_URL = normalizeDatabaseUrl(process.env.DATABASE_URL);

// Helpful boot log (no password)
try {
  const u = new URL(DATABASE_URL);
  console.log("[DB] target:", `${u.protocol}//${u.username}@${u.host}${u.pathname}`);
} catch {
  // ignore
}

export const pool = new Pool({
  connectionString: DATABASE_URL,

  // Supabase requires SSL from hosted environments
  ssl: { rejectUnauthorized: false },

  // Small pool so free tiers don't choke
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
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
