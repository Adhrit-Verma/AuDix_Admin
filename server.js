import "dotenv/config";
import express from "express";
import session from "express-session";
import pgSession from "connect-pg-simple";
import http from "http";
import { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";

import { pool, query, migrate } from "./db_pg.js";
import {
  adminCreateFlatRequest,
  adminListRequests,
  adminApproveRequest,
  adminGenerateSetupCode,
  adminListFlats,
  adminRevokeBan,
  adminDisableFlat
} from "./admin_db_pg.js";

try {
  await migrate();
  console.log("[DB] Postgres connected");
} catch (e) {
  console.error("[DB] migrate/connect failed:", e?.message || e);
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 5004);
const ADMIN_PASSWORD = process.env.AUDIX_ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";

if (!ADMIN_PASSWORD) {
  console.error("Missing AUDIX_ADMIN_PASSWORD in env");
  process.exit(1);
}
if (!SESSION_SECRET) {
  console.error("Missing SESSION_SECRET in env");
  process.exit(1);
}

const USER_BASE_URL = process.env.AUDIX_USER_BASE_URL || "";
const LIVE_TOKEN = process.env.AUDIX_LIVE_TOKEN || "";

if (!USER_BASE_URL) {
  console.error("Missing AUDIX_USER_BASE_URL in env");
  process.exit(1);
}
if (!LIVE_TOKEN) {
  console.error("Missing AUDIX_LIVE_TOKEN in env");
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
app.set("trust proxy", 1);


// --- sessions (Postgres store for production) ---
const PgSession = pgSession(session);

const sessionParser = session({
  name: "audix_admin_sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,

  // ✅ Store sessions in Postgres (Supabase)
  store: new PgSession({
    pool,                       // from db_pg.js
    tableName: "admin_sessions",
    createTableIfMissing: true,
  }),

  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production", // Render = production
    maxAge: 1000 * 60 * 60 * 24 * 7,               // 7 days
  },
});

app.use(sessionParser);


app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- CSP (allows local assets + WS) ---
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' ws: wss:; " +
    "img-src 'self' data:; " +
    "font-src 'self' data:;"
  );
  next();
});

// --- stop favicon 404 spam ---
app.get("/favicon.ico", (req, res) => res.status(204).end());

// --- simple metrics ---
const metrics = {
  startedAt: Date.now(),
  totalRequests: 0,
  inFlight: 0,
  uniqueIPs: new Set(),
  requestTimestamps: []
};

function pruneOldRequests(now) {
  const cutoff = now - 60_000;
  while (metrics.requestTimestamps.length && metrics.requestTimestamps[0] < cutoff) {
    metrics.requestTimestamps.shift();
  }
}

app.use((req, res, next) => {
  const now = Date.now();

  metrics.totalRequests += 1;
  metrics.inFlight += 1;
  metrics.uniqueIPs.add(req.ip);
  metrics.requestTimestamps.push(now);
  pruneOldRequests(now);

  res.on("finish", () => {
    metrics.inFlight = Math.max(0, metrics.inFlight - 1);
  });

  next();
});

// --- static admin pages ---
app.use("/public", express.static(path.join(__dirname, "public"), { maxAge: 0 }));

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin === true) return next();

  if (req.path.startsWith("/admin/api")) {
    return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  }

  return res.redirect("/admin/login");
}

// Login page
app.get("/admin/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin-login.html"));
});

// Login handler (supports Remember Me)
app.post("/admin/login", (req, res) => {
  const { password, remember } = req.body || {};
  if (typeof password !== "string") return res.status(400).send("Bad request");

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).send("Invalid password");
  }

  req.session.isAdmin = true;

  if (remember === "1" || remember === "on") {
    req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
  } else {
    req.session.cookie.expires = false;
  }

  req.session.save(() => res.redirect("/admin"));
});

// Logout
app.post("/admin/logout", requireAdmin, (req, res) => {
  req.session.destroy(() => res.redirect("/admin/login"));
});

// Dashboard
app.get("/admin", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin-dashboard.html"));
});

// -------- Live activity from user snapshot --------
app.get("/admin/api/live", requireAdmin, async (req, res) => {
  try {
    const snap = await fetchUserLiveSnapshot();
    res.json({ ok: true, snap });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message || "LIVE_FETCH_FAILED" });
  }
});

async function fetchUserLiveSnapshot() {
  const url = new URL("/api/internal/live-snapshot", USER_BASE_URL).toString();

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "x-audix-live-token": LIVE_TOKEN
    }
  });

  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) {
    const text = await res.text().catch(() => "");
    throw new Error(`BAD_SNAPSHOT_RESPONSE (${res.status}) ${text.slice(0, 120)}`);
  }

  const data = await res.json();
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error || `SNAPSHOT_HTTP_${res.status}`);
  }

  return data;
}

// ---- ADMIN DB APIs (admin-only) ----

// Create a flat request manually
app.post("/admin/api/requests", requireAdmin, async (req, res) => {
  const { flat_id, name, note } = req.body || {};
  if (!flat_id || !name) return res.status(400).json({ ok: false, error: "flat_id and name required" });

  const id = await adminCreateFlatRequest(query, {
    flat_id: String(flat_id).trim().toUpperCase(),
    name: String(name).trim(),
    note: String(note || "")
  });

  res.json({ ok: true, id });
});

// List pending/approved/rejected requests
app.get("/admin/api/requests", requireAdmin, async (req, res) => {
  const status = String(req.query.status || "PENDING").toUpperCase();
  const rows = await adminListRequests(query, status);
  res.json({ ok: true, rows });
});

// Approve a request -> creates/activates flat
app.post("/admin/api/requests/:id/approve", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });

  const out = await adminApproveRequest(query, id);
  if (!out.ok) return res.status(404).json(out);
  res.json(out);
});

// ✅ Reject a request (Postgres version)
app.post("/admin/api/requests/:id/reject", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });

  const now = Date.now();

  const exists = await query(`SELECT id FROM flat_requests WHERE id=$1`, [id]);
  if (!exists.rows[0]) return res.status(404).json({ ok: false, error: "REQUEST_NOT_FOUND" });

  await query(`UPDATE flat_requests SET status='REJECTED', updated_at=$2 WHERE id=$1`, [id, now]);
  res.json({ ok: true });
});

// Generate one-time setup code for a flat
app.post("/admin/api/flats/:flat_id/setup-code", requireAdmin, async (req, res) => {
  const flat_id = String(req.params.flat_id).trim().toUpperCase();
  const ttlMinutes = Number(req.body?.ttlMinutes ?? 60);

  const out = await adminGenerateSetupCode(query, {
    flat_id,
    ttlMinutes: Number.isFinite(ttlMinutes) ? ttlMinutes : 60
  });
  if (!out.ok) return res.status(404).json(out);

  res.json(out);
});

// Search/list flats
app.get("/admin/api/flats", requireAdmin, async (req, res) => {
  const q = String(req.query.q || "").trim().toUpperCase();
  const rows = await adminListFlats(query, q);
  res.json({ ok: true, rows });
});

// Revoke ban
app.post("/admin/api/flats/:flat_id/revoke-ban", requireAdmin, async (req, res) => {
  const flat_id = String(req.params.flat_id).trim().toUpperCase();
  const out = await adminRevokeBan(query, flat_id);
  if (!out.ok) return res.status(404).json(out);
  res.json(out);
});

// Disable/Enable flat
app.post("/admin/api/flats/:flat_id/disable", requireAdmin, async (req, res) => {
  const flat_id = String(req.params.flat_id).trim().toUpperCase();
  const disabled = Boolean(req.body?.disabled ?? true);
  const out = await adminDisableFlat(query, flat_id, disabled);
  if (!out.ok) return res.status(404).json(out);
  res.json(out);
});

// Small JSON endpoint for quick checks
app.get("/admin/api/metrics", requireAdmin, (req, res) => {
  const now = Date.now();
  pruneOldRequests(now);

  res.json({
    uptimeSec: Math.floor((now - metrics.startedAt) / 1000),
    totalRequests: metrics.totalRequests,
    inFlight: metrics.inFlight,
    uniqueIPs: metrics.uniqueIPs.size,
    rpm: metrics.requestTimestamps.length,
    mem: process.memoryUsage()
  });
});

// ✅ Disable DB Viewer/Editor for Postgres for now (prevents crashes)
app.get("/admin/api/db/tables", requireAdmin, (req, res) => {
  res.status(501).json({ ok: false, error: "DB_VIEWER_DISABLED_ON_POSTGRES" });
});
app.get("/admin/api/db/table/:table/meta", requireAdmin, (req, res) => {
  res.status(501).json({ ok: false, error: "DB_VIEWER_DISABLED_ON_POSTGRES" });
});
app.get("/admin/api/db/table/:table/rows", requireAdmin, (req, res) => {
  res.status(501).json({ ok: false, error: "DB_VIEWER_DISABLED_ON_POSTGRES" });
});
app.post("/admin/api/db/table/:table/update", requireAdmin, (req, res) => {
  res.status(501).json({ ok: false, error: "DB_VIEWER_DISABLED_ON_POSTGRES" });
});
app.post("/admin/api/db/table/:table/delete", requireAdmin, (req, res) => {
  res.status(501).json({ ok: false, error: "DB_VIEWER_DISABLED_ON_POSTGRES" });
});
app.post("/admin/api/db/table/:table/insert", requireAdmin, (req, res) => {
  res.status(501).json({ ok: false, error: "DB_VIEWER_DISABLED_ON_POSTGRES" });
});

// --- WebSocket live updates (admin only) ---
const wss = new WebSocketServer({ noServer: true });
const wsClients = new Set();

function buildSnapshot() {
  const now = Date.now();
  pruneOldRequests(now);

  const mu = process.memoryUsage();

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  const cpuCores = os.cpus().length;
  const [load1] = os.loadavg();
  const cpuPressure = cpuCores ? load1 / cpuCores : 0;

  return {
    ts: now,
    uptimeSec: Math.floor((now - metrics.startedAt) / 1000),
    totalRequests: metrics.totalRequests,
    inFlight: metrics.inFlight,
    uniqueIPs: metrics.uniqueIPs.size,
    rpm: metrics.requestTimestamps.length,
    viewers: wsClients.size,

    mem: {
      rss: mu.rss,
      heapUsed: mu.heapUsed,
      heapTotal: mu.heapTotal,
      external: mu.external
    },

    hw: {
      totalMem,
      usedMem,
      freeMem,
      cpuCores,
      load1,
      cpuPressure
    },

    thresholds: {
      cpuWarn: 0.7,
      cpuCrit: 0.9,
      ramWarn: 0.7,
      ramCrit: 0.85,
      rpmWarn: 120,
      rpmCrit: 240
    }
  };
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wsClients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

server.on("upgrade", (req, socket, head) => {
  if (!req.url?.startsWith("/admin/ws")) {
    socket.destroy();
    return;
  }

  sessionParser(req, {}, () => {
    if (!req.session?.isAdmin) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
});

wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.send(JSON.stringify(buildSnapshot()));

  ws.on("close", () => {
    wsClients.delete(ws);
  });
});

setInterval(() => {
  if (wsClients.size > 0) broadcast(buildSnapshot());
}, 1000);

app.get("/", (req, res) => res.redirect("/admin/login"));

server.listen(PORT, () => {
  console.log(`AuDiX Admin running on http://localhost:${PORT}`);
});
