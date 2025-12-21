import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

import { query, migrate } from "./db_pg.js";
import {
  adminCreateFlatRequest,
  adminListRequests,
  adminApproveRequest,
  adminGenerateSetupCode,
  adminListFlats,
  adminRevokeBan,
  adminDisableFlat
} from "./admin_db_pg.js";

await migrate();
console.log("[DB] Postgres connected");


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 5004);
const ADMIN_PASSWORD = process.env.AUDIX_ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const AUDIX_DB_FILE = process.env.AUDIX_DB_FILE || 'audix.sqlite';

if (!ADMIN_PASSWORD) {
    console.error('Missing AUDIX_ADMIN_PASSWORD in .env');
    process.exit(1);
}
if (!SESSION_SECRET) {
    console.error('Missing SESSION_SECRET in .env');
    process.exit(1);
}



const USER_BASE_URL = process.env.AUDIX_USER_BASE_URL || '';
const LIVE_TOKEN = process.env.AUDIX_LIVE_TOKEN || '';

if (!USER_BASE_URL) {
    console.error('Missing AUDIX_USER_BASE_URL in .env');
    process.exit(1);
}
if (!LIVE_TOKEN) {
    console.error('Missing AUDIX_LIVE_TOKEN in .env');
    process.exit(1);
}


const app = express();
const server = http.createServer(app);

// --- sessions ---
const sessionParser = session({
    name: 'audix_admin_sid',     // ✅ NEW
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax'
    }
});
app.use(sessionParser);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- CSP (allows local assets + WS) ---
app.use((req, res, next) => {
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "connect-src 'self' ws: wss:; " +
        "img-src 'self' data:; " +
        "font-src 'self' data:;"
    );
    next();
});
// Live activity (from user server snapshot)
app.get('/admin/api/live', requireAdmin, async (req, res) => {
  try {
    const snap = await fetchUserLiveSnapshot();
    res.json({ ok: true, snap });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message || 'LIVE_FETCH_FAILED' });
  }
});


async function fetchUserLiveSnapshot() {
    const url = new URL('/api/internal/live-snapshot', USER_BASE_URL).toString();

    const res = await fetch(url, {
        method: 'GET',
        headers: {
            'x-audix-live-token': LIVE_TOKEN
        }
    });

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('application/json')) {
        const text = await res.text().catch(() => '');
        throw new Error(`BAD_SNAPSHOT_RESPONSE (${res.status}) ${text.slice(0, 120)}`);
    }

    const data = await res.json();
    if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || `SNAPSHOT_HTTP_${res.status}`);
    }

    return data;
}


// --- stop favicon 404 spam ---
app.get('/favicon.ico', (req, res) => res.status(204).end());

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

    res.on('finish', () => {
        metrics.inFlight = Math.max(0, metrics.inFlight - 1);
    });

    next();
});

// --- static admin pages ---
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

function requireAdmin(req, res, next) {
    if (req.session?.isAdmin === true) return next();

    // If API request, return JSON instead of redirecting to HTML login
    if (req.path.startsWith('/admin/api')) {
        return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }

    return res.redirect('/admin/login');
}


// Login page
app.get('/admin/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

// Login handler (supports Remember Me)
app.post('/admin/login', (req, res) => {
    const { password, remember } = req.body || {};
    if (typeof password !== 'string') return res.status(400).send('Bad request');

    if (password !== ADMIN_PASSWORD) {
        return res.status(401).send('Invalid password');
    }

    req.session.isAdmin = true;

    if (remember === '1' || remember === 'on') {
        req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
    } else {
        req.session.cookie.expires = false;
    }

    req.session.save(() => res.redirect('/admin'));
});

// Logout
app.post('/admin/logout', requireAdmin, (req, res) => {
    req.session.destroy(() => res.redirect('/admin/login'));
});

// Dashboard
app.get('/admin', requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-dashboard.html'));
});

// ---- ADMIN DB APIs (admin-only) ----

// Create a flat request manually (you can also later expose this to user app)
app.post('/admin/api/requests', requireAdmin, (req, res) => {
    const { flat_id, name, note } = req.body || {};
    if (!flat_id || !name) return res.status(400).json({ ok: false, error: 'flat_id and name required' });

    const id = adminCreateFlatRequest(query, { flat_id: String(flat_id).trim().toUpperCase(), name: String(name).trim(), note: String(note || '') });
    res.json({ ok: true, id });
});

// List pending/approved/rejected requests
app.get('/admin/api/requests', requireAdmin, (req, res) => {
    const status = String(req.query.status || 'PENDING').toUpperCase();
    const rows = adminListRequests(query, status);
    res.json({ ok: true, rows });
});

// Approve a request -> creates/activates flat
app.post('/admin/api/requests/:id/approve', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'bad id' });

    const out = adminApproveRequest(query, id);
    if (!out.ok) return res.status(404).json(out);
    res.json(out);
});

// Reject a request
app.post('/admin/api/requests/:id/reject', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'bad id' });

    const now = Date.now();
    const row = db.prepare(`SELECT id FROM flat_requests WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ ok: false, error: 'REQUEST_NOT_FOUND' });

    db.prepare(`UPDATE flat_requests SET status='REJECTED', updated_at=? WHERE id=?`).run(now, id);
    res.json({ ok: true });
});


// Generate one-time setup code for a flat (also clears pin_hash to force new setup)
app.post('/admin/api/flats/:flat_id/setup-code', requireAdmin, async (req, res) => {
    const flat_id = String(req.params.flat_id).trim().toUpperCase();
    const ttlMinutes = Number(req.body?.ttlMinutes ?? 60);

    const out = await adminGenerateSetupCode(query, { flat_id, ttlMinutes: Number.isFinite(ttlMinutes) ? ttlMinutes : 60 });
    if (!out.ok) return res.status(404).json(out);

    // Return the plain code ONCE so you can send it on WhatsApp
    res.json(out);
});

// Search/list flats
app.get('/admin/api/flats', requireAdmin, (req, res) => {
    const q = String(req.query.q || '').trim().toUpperCase();
    const rows = adminListFlats(query, q);
    res.json({ ok: true, rows });
});

// Revoke ban (your “after 24h admin decides” rule)
app.post('/admin/api/flats/:flat_id/revoke-ban', requireAdmin, (req, res) => {
    const flat_id = String(req.params.flat_id).trim().toUpperCase();
    const out = adminRevokeBan(query, flat_id);
    if (!out.ok) return res.status(404).json(out);
    res.json(out);
});

// Disable/Enable flat
app.post('/admin/api/flats/:flat_id/disable', requireAdmin, (req, res) => {
    const flat_id = String(req.params.flat_id).trim().toUpperCase();
    const disabled = Boolean(req.body?.disabled ?? true);
    const out = adminDisableFlat(query, flat_id, disabled);
    if (!out.ok) return res.status(404).json(out);
    res.json(out);
});

// Small JSON endpoint for quick checks (admin only)
app.get('/admin/api/metrics', requireAdmin, (req, res) => {
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


// ------------------------------
// DB Viewer / Editor (admin-only)
// ------------------------------
const DB_ALLOW_TABLES = new Set([
    'flat_requests',
    'flats',
    'setup_codes',
    'admin_audit'
]);

function assertAllowedTable(name) {
    if (!DB_ALLOW_TABLES.has(name)) {
        const err = new Error('TABLE_NOT_ALLOWED');
        err.status = 400;
        throw err;
    }
}

function getTableInfo(table) {
    assertAllowedTable(table);
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    const pkCols = cols.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name);
    return { cols, pkCols };
}

// List tables
app.get('/admin/api/db/tables', requireAdmin, (req, res) => {
    const rows = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all();

    const names = rows.map(r => r.name).filter(n => DB_ALLOW_TABLES.has(n));
    res.json({ ok: true, tables: names });
});

// Describe a table
app.get('/admin/api/db/table/:table/meta', requireAdmin, (req, res) => {
    try {
        const table = String(req.params.table);
        const { cols, pkCols } = getTableInfo(table);
        res.json({ ok: true, cols, pkCols });
    } catch (e) {
        res.status(e.status || 500).json({ ok: false, error: e.message || 'DB_META_ERROR' });
    }
});

// View rows
app.get('/admin/api/db/table/:table/rows', requireAdmin, (req, res) => {
    try {
        const table = String(req.params.table);
        const { cols, pkCols } = getTableInfo(table);

        const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
        const offset = Math.max(0, Number(req.query.offset || 0));

        // If has PK -> stable order
        const orderBy = pkCols.length ? `ORDER BY ${pkCols.map(c => `"${c}"`).join(', ')}` : '';

        const rows = db.prepare(`SELECT * FROM "${table}" ${orderBy} LIMIT ? OFFSET ?`).all(limit, offset);

        // total count (for pagination)
        const total = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c;

        res.json({ ok: true, cols: cols.map(c => c.name), pkCols, rows, limit, offset, total });
    } catch (e) {
        res.status(e.status || 500).json({ ok: false, error: e.message || 'DB_ROWS_ERROR' });
    }
});

// Update a row (by PK)
app.post('/admin/api/db/table/:table/update', requireAdmin, (req, res) => {
    try {
        const table = String(req.params.table);
        const { cols, pkCols } = getTableInfo(table);
        if (!pkCols.length) return res.status(400).json({ ok: false, error: 'NO_PRIMARY_KEY' });

        const { pk, values } = req.body || {};
        if (!pk || typeof pk !== 'object') return res.status(400).json({ ok: false, error: 'PK_REQUIRED' });
        if (!values || typeof values !== 'object') return res.status(400).json({ ok: false, error: 'VALUES_REQUIRED' });

        const colSet = new Set(cols.map(c => c.name));
        const updates = Object.keys(values).filter(k => colSet.has(k) && !pkCols.includes(k));

        if (!updates.length) return res.json({ ok: true, changes: 0 });

        const setSql = updates.map(k => `"${k}" = @${k}`).join(', ');
        const whereSql = pkCols.map(k => `"${k}" = @pk_${k}`).join(' AND ');

        const stmt = db.prepare(`UPDATE "${table}" SET ${setSql} WHERE ${whereSql}`);
        const params = {};
        for (const k of updates) params[k] = values[k];
        for (const k of pkCols) params[`pk_${k}`] = pk[k];

        const info = stmt.run(params);
        res.json({ ok: true, changes: info.changes });
    } catch (e) {
        res.status(e.status || 500).json({ ok: false, error: e.message || 'DB_UPDATE_ERROR' });
    }
});

// Delete a row (by PK)
app.post('/admin/api/db/table/:table/delete', requireAdmin, (req, res) => {
    try {
        const table = String(req.params.table);
        const { pkCols } = getTableInfo(table);
        if (!pkCols.length) return res.status(400).json({ ok: false, error: 'NO_PRIMARY_KEY' });

        const { pk } = req.body || {};
        if (!pk || typeof pk !== 'object') return res.status(400).json({ ok: false, error: 'PK_REQUIRED' });

        const whereSql = pkCols.map(k => `"${k}" = @pk_${k}`).join(' AND ');
        const stmt = db.prepare(`DELETE FROM "${table}" WHERE ${whereSql}`);

        const params = {};
        for (const k of pkCols) params[`pk_${k}`] = pk[k];

        const info = stmt.run(params);
        res.json({ ok: true, changes: info.changes });
    } catch (e) {
        res.status(e.status || 500).json({ ok: false, error: e.message || 'DB_DELETE_ERROR' });
    }
});

// Insert a row
app.post('/admin/api/db/table/:table/insert', requireAdmin, (req, res) => {
    try {
        const table = String(req.params.table);
        const { cols } = getTableInfo(table);

        const { values } = req.body || {};
        if (!values || typeof values !== 'object') return res.status(400).json({ ok: false, error: 'VALUES_REQUIRED' });

        const colSet = new Set(cols.map(c => c.name));
        const insertCols = Object.keys(values).filter(k => colSet.has(k));

        if (!insertCols.length) return res.status(400).json({ ok: false, error: 'NO_VALID_COLUMNS' });

        const colSql = insertCols.map(c => `"${c}"`).join(', ');
        const valSql = insertCols.map(c => `@${c}`).join(', ');

        const stmt = db.prepare(`INSERT INTO "${table}" (${colSql}) VALUES (${valSql})`);
        const info = stmt.run(values);

        res.json({ ok: true, lastInsertRowid: info.lastInsertRowid, changes: info.changes });
    } catch (e) {
        res.status(e.status || 500).json({ ok: false, error: e.message || 'DB_INSERT_ERROR' });
    }
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

server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/admin/ws')) {
        socket.destroy();
        return;
    }

    sessionParser(req, {}, () => {
        if (!req.session?.isAdmin) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    });
});

wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws.send(JSON.stringify(buildSnapshot()));

    ws.on('close', () => {
        wsClients.delete(ws);
    });
});

setInterval(() => {
    if (wsClients.size > 0) broadcast(buildSnapshot());
}, 1000);

app.get('/', (req, res) => res.redirect('/admin/login'));

server.listen(PORT, () => {
    console.log(`AuDiX Admin running on http://localhost:${PORT}`);
    console.log(`DB file: ./data/${AUDIX_DB_FILE}`);
});
