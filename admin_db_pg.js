import bcrypt from "bcrypt";

export function generateHumanCode(len = 8) {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const a = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
  const b = Array.from({ length: 4 }, () => digits[Math.floor(Math.random() * digits.length)]).join("");
  return `${a}-${b}`.slice(0, len + 1);
}

export async function adminCreateFlatRequest(query, { flat_id, name, note = "" }) {
  const now = Date.now();
  const res = await query(
    `INSERT INTO flat_requests (flat_id, name, note, status, created_at, updated_at)
     VALUES ($1,$2,$3,'PENDING',$4,$4)
     RETURNING id`,
    [flat_id, name, note, now]
  );
  return res.rows[0].id;
}

export async function adminListRequests(query, status = "PENDING", limit = 200) {
  const res = await query(
    `SELECT id, flat_id, name, note, status, created_at, updated_at
     FROM flat_requests
     WHERE status = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [status, limit]
  );
  return res.rows;
}

export async function adminApproveRequest(query, requestId) {
  const now = Date.now();

  const reqRes = await query(`SELECT * FROM flat_requests WHERE id = $1`, [requestId]);
  const req = reqRes.rows[0];
  if (!req) return { ok: false, error: "REQUEST_NOT_FOUND" };

  // upsert flat
  await query(
    `INSERT INTO flats (flat_id, status, created_at, updated_at)
     VALUES ($1,'ACTIVE',$2,$2)
     ON CONFLICT (flat_id)
     DO UPDATE SET status='ACTIVE', updated_at=$2`,
    [req.flat_id, now]
  );

  await query(`UPDATE flat_requests SET status='APPROVED', updated_at=$2 WHERE id=$1`, [requestId, now]);
  return { ok: true, flat_id: req.flat_id };
}

export async function adminGenerateSetupCode(query, { flat_id, ttlMinutes = 60 }) {
  const now = Date.now();

  const flatRes = await query(`SELECT flat_id FROM flats WHERE flat_id = $1`, [flat_id]);
  if (!flatRes.rows[0]) return { ok: false, error: "FLAT_NOT_FOUND" };

  const code = generateHumanCode(9);
  const code_hash = await bcrypt.hash(code, 10);
  const expires_at = now + ttlMinutes * 60_000;

  await query(
    `INSERT INTO setup_codes (flat_id, code_hash, expires_at, created_at)
     VALUES ($1,$2,$3,$4)`,
    [flat_id, code_hash, expires_at, now]
  );

  await query(`UPDATE flats SET pin_hash = NULL, updated_at = $2 WHERE flat_id = $1`, [flat_id, now]);

  return { ok: true, flat_id, code, expires_at };
}

export async function adminListFlats(query, q = "", limit = 200) {
  const like = `%${q}%`;
  const res = await query(
    `SELECT flat_id, status, strike_count, ban_until, requires_admin_revoke, created_at, last_login_at
     FROM flats
     WHERE flat_id ILIKE $1
     ORDER BY flat_id ASC
     LIMIT $2`,
    [like, limit]
  );
  return res.rows;
}

export async function adminRevokeBan(query, flat_id) {
  const now = Date.now();
  const flatRes = await query(`SELECT flat_id FROM flats WHERE flat_id=$1`, [flat_id]);
  if (!flatRes.rows[0]) return { ok: false, error: "FLAT_NOT_FOUND" };

  await query(
    `UPDATE flats
     SET ban_until = NULL, requires_admin_revoke = FALSE, updated_at = $2
     WHERE flat_id = $1`,
    [flat_id, now]
  );

  return { ok: true };
}

export async function adminDisableFlat(query, flat_id, disabled = true) {
  const now = Date.now();
  const flatRes = await query(`SELECT flat_id FROM flats WHERE flat_id=$1`, [flat_id]);
  if (!flatRes.rows[0]) return { ok: false, error: "FLAT_NOT_FOUND" };

  await query(
    `UPDATE flats
     SET status = $2, updated_at = $3
     WHERE flat_id = $1`,
    [flat_id, disabled ? "DISABLED" : "ACTIVE", now]
  );

  return { ok: true };
}
