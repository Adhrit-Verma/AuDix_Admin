(function () {
  const $ = (id) => document.getElementById(id);

  // ---------- utils ----------
  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function fmtTime(ms) {
    if (!ms) return '-';
    try { return new Date(ms).toLocaleString(); } catch { return String(ms); }
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return '-';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0, x = n;
    while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
    return `${x.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
  }

  function pct(n) { return Math.max(0, Math.min(100, Math.round(n * 100))); }
  function setBar(el, p) { if (el) el.style.width = `${p}%`; }

  function setAlert(el, level, text) {
    if (!el) return;
    el.classList.remove('alert-warn', 'alert-crit');
    if (level === 'warn') el.classList.add('alert-warn');
    if (level === 'crit') el.classList.add('alert-crit');
    el.textContent = text || '';
  }

  function setStatus(level, text, icon) {
    const banner = $('statusBanner');
    const iconEl = $('statusIcon');
    const textEl = $('statusText');
    if (!banner || !iconEl || !textEl) return;

    banner.classList.remove('ok', 'warn', 'crit');
    banner.classList.add(level);
    iconEl.textContent = icon;
    textEl.textContent = text;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    }
  }

  // ---------- API helper (handles HTML/redirect safety) ----------
  async function api(url, opts = {}) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });

    const ct = (res.headers.get('content-type') || '').toLowerCase();

    // If server returns HTML (login page), handle nicely
    if (!ct.includes('application/json')) {
      const text = await res.text();
      if (text.trim().startsWith('<!doctype') || text.includes('<html')) {
        throw new Error('Session expired. Please login again.');
      }
      throw new Error(`Unexpected response type: ${ct || 'unknown'}`);
    }

    const data = await res.json();

    if (!res.ok || data?.ok === false) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }

    return data;
  }

  // ---------- Inline setup code rendering ----------
  // We keep per-row timers so they auto-clear when expired.
  const inlineTimers = new Map(); // key -> intervalId

  function msLeft(expiresAt) {
    return Math.max(0, Number(expiresAt) - Date.now());
  }

  function fmtCountdown(ms) {
    const s = Math.ceil(ms / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m <= 0) return `${r}s`;
    return `${m}m ${r}s`;
  }

  function clearInline(key) {
    const t = inlineTimers.get(key);
    if (t) clearInterval(t);
    inlineTimers.delete(key);
  }

  function renderInlineCode({ slotEl, key, code, expiresAt }) {
    if (!slotEl) return;

    // stop old timer if any
    clearInline(key);

    // base UI
    slotEl.innerHTML = `
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <div style="font-family: ui-monospace, Menlo, Consolas, monospace; font-weight:800; letter-spacing:0.5px;">
          ${escapeHtml(code)}
        </div>
        <button class="btn" data-copy="${escapeHtml(code)}">Copy</button>
        <span class="small" data-exp>Expires in: ...</span>
      </div>
    `;

    // copy handler
    const copyBtn = slotEl.querySelector('button[data-copy]');
    copyBtn?.addEventListener('click', async () => {
      await copyText(code);
    });

    // countdown + auto-clear
    const expSpan = slotEl.querySelector('[data-exp]');

    const tick = () => {
      const left = msLeft(expiresAt);
      if (left <= 0) {
        expSpan.textContent = 'Expired';
        // clear UI (empty column) after a short moment
        setTimeout(() => {
          slotEl.innerHTML = '';
        }, 500);
        clearInline(key);
        return;
      }
      expSpan.textContent = `Expires in: ${fmtCountdown(left)}`;
    };

    tick();
    const intervalId = setInterval(tick, 1000);
    inlineTimers.set(key, intervalId);
  }

  // ---------- tabs ----------
  function initTabs() {
    const tabButtons = document.querySelectorAll('.tabBtn');

    tabButtons.forEach(btn => {
      btn.addEventListener('click', async () => {
        tabButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const tab = btn.getAttribute('data-tab');
        document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
        const section = document.getElementById(`tab-${tab}`);
        if (section) section.classList.add('active');

        // auto-load
        if (tab === 'requests') await loadRequests();
        if (tab === 'live') await loadLive();
        if (tab === 'flats') await loadFlats();
        if (tab === 'db') {
          if (!$('dbTableSelect')?.options?.length) initDbUI();
        }
      });
    });
  }

  // ---------- monitor ----------
  function renderMonitor(s) {
    $('uptime').textContent = s.uptimeSec ?? '-';
    $('totalRequests').textContent = s.totalRequests ?? '-';
    $('rpm').textContent = s.rpm ?? '-';
    $('inFlight').textContent = s.inFlight ?? '-';
    $('uniqueIPs').textContent = s.uniqueIPs ?? '-';
    $('viewers').textContent = s.viewers ?? '-';

    const mem = s.mem || {};
    $('mem').textContent =
      `rss:      ${fmtBytes(mem.rss)}\n` +
      `heapUsed: ${fmtBytes(mem.heapUsed)}\n` +
      `heapTotal:${fmtBytes(mem.heapTotal)}\n` +
      `external: ${fmtBytes(mem.external)}\n`;

    const hw = s.hw || {};
    const th = s.thresholds || {};

    const cpuPressure = Number(hw.cpuPressure ?? 0);
    const cpuBarRatio = Math.min(cpuPressure, 1);
    if ($('cpuText')) {
      if (hw.cpuCores) {
        const load1 = Number(hw.load1 ?? 0);
        $('cpuText').textContent = `${Math.round(cpuPressure * 100)}% (load1 ${load1.toFixed(2)} / ${hw.cpuCores} cores)`;
      } else $('cpuText').textContent = '-';
    }
    setBar($('cpuBar'), pct(cpuBarRatio));
    if (cpuPressure >= Number(th.cpuCrit ?? 0.9)) setAlert($('cpuAlert'), 'crit', 'CRITICAL: CPU pressure high');
    else if (cpuPressure >= Number(th.cpuWarn ?? 0.7)) setAlert($('cpuAlert'), 'warn', 'Warning: CPU pressure rising');
    else setAlert($('cpuAlert'), '', '');

    const rss = Number(mem.rss ?? 0);
    const totalMem = Number(hw.totalMem ?? 0);
    let ramRatio = 0;

    if (totalMem > 0 && $('ramText')) {
      ramRatio = rss / totalMem;
      $('ramText').textContent = `${fmtBytes(rss)} / ${fmtBytes(totalMem)} (${(ramRatio * 100).toFixed(1)}%)`;
      setBar($('ramBar'), pct(ramRatio));
      if (ramRatio >= Number(th.ramCrit ?? 0.85)) setAlert($('ramAlert'), 'crit', 'CRITICAL: RAM usage high');
      else if (ramRatio >= Number(th.ramWarn ?? 0.7)) setAlert($('ramAlert'), 'warn', 'Warning: RAM usage rising');
      else setAlert($('ramAlert'), '', '');
    }

    const rpm = Number(s.rpm ?? 0);
    if ($('rpmText')) $('rpmText').textContent = `${rpm} rpm`;
    const rpmWarn = Number(th.rpmWarn ?? 120);
    const rpmCrit = Number(th.rpmCrit ?? 240);
    const rpmRatio = rpmCrit > 0 ? Math.min(rpm / rpmCrit, 1) : 0;
    setBar($('rpmBar'), pct(rpmRatio));
    if (rpm >= rpmCrit) setAlert($('rpmAlert'), 'crit', 'CRITICAL: request rate very high');
    else if (rpm >= rpmWarn) setAlert($('rpmAlert'), 'warn', 'Warning: request rate high');
    else setAlert($('rpmAlert'), '', '');

    // banner
    let level = 'ok', text = 'SYSTEM OK', icon = '✅';
    if (cpuPressure >= Number(th.cpuCrit ?? 0.9) || (totalMem > 0 && ramRatio >= Number(th.ramCrit ?? 0.85)) || rpm >= rpmCrit) {
      level = 'crit'; text = 'CRITICAL: System under heavy load'; icon = '❌';
    } else if (cpuPressure >= Number(th.cpuWarn ?? 0.7) || (totalMem > 0 && ramRatio >= Number(th.ramWarn ?? 0.7)) || rpm >= rpmWarn) {
      level = 'warn'; text = 'WARNING: System load rising'; icon = '⚠️';
    }
    setStatus(level, text, icon);
  }

  // ---------- Requests ----------
  async function loadRequests() {
    const status = $('reqStatus')?.value || 'PENDING';
    $('reqMsg').textContent = 'Loading...';
    $('reqMsg').classList.remove('err');

    try {
      const data = await api(`/admin/api/requests?status=${encodeURIComponent(status)}`, { method: 'GET' });
      const rows = data.rows || [];
      const tbody = $('reqTable').querySelector('tbody');
      tbody.innerHTML = '';

      for (const r of rows) {
        const tr = document.createElement('tr');
        const pillClass =
          r.status === 'PENDING' ? 'pending' :
            r.status === 'APPROVED' ? 'approved' :
              'rejected';

        // IMPORTANT: include a slot <div> for inline code in the actions cell
        tr.innerHTML = `
          <td>${r.id}</td>
          <td><b>${escapeHtml(r.flat_id)}</b></td>
          <td>${escapeHtml(r.name)}</td>
          <td>${escapeHtml(r.note || '')}</td>
          <td><span class="pill ${pillClass}">${escapeHtml(r.status)}</span></td>
          <td>${fmtTime(r.created_at)}</td>
          <td>
            <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
              ${r.status === 'PENDING'
            ? `
                  <button class="btn btnPrimary" data-approve="${r.id}">Approve</button>
                  <button class="btn btnDanger" data-reject="${r.id}">Reject</button>
                `
            : `<button class="btn" data-setup="${escapeHtml(r.flat_id)}">Setup Code</button>`
          }
            </div>
            <div id="req-code-${r.id}" style="margin-top:8px;"></div>
          </td>
        `;
        tbody.appendChild(tr);
      }

      $('reqMsg').textContent = rows.length ? `Showing ${rows.length} request(s).` : 'No requests found.';
    } catch (e) {
      $('reqMsg').textContent = `Error: ${e.message}`;
      $('reqMsg').classList.add('err');
    }
  }

  async function createRequestFromUI() {
    const flat_id = ($('newFlatId').value || '').trim().toUpperCase();
    const name = ($('newName').value || '').trim();
    const note = ($('newNote').value || '').trim();

    $('newReqMsg').textContent = '';
    $('newReqMsg').classList.remove('err');

    if (!flat_id || !name) {
      $('newReqMsg').textContent = 'flat_id and name required';
      $('newReqMsg').classList.add('err');
      return;
    }

    try {
      const out = await api('/admin/api/requests', { method: 'POST', body: JSON.stringify({ flat_id, name, note }) });
      $('newReqMsg').textContent = `Created request #${out.id}`;
      $('newFlatId').value = '';
      $('newName').value = '';
      $('newNote').value = '';
      await loadRequests();
    } catch (e) {
      $('newReqMsg').textContent = `Error: ${e.message}`;
      $('newReqMsg').classList.add('err');
    }
  }

  async function approveRequest(id) {
    $('reqMsg').textContent = 'Approving...';
    $('reqMsg').classList.remove('err');

    try {
      const out = await api(`/admin/api/requests/${id}/approve`, { method: 'POST' });
      $('reqMsg').textContent = `Approved. Flat: ${out.flat_id}`;
      await loadRequests();
    } catch (e) {
      $('reqMsg').textContent = `Error: ${e.message}`;
      $('reqMsg').classList.add('err');
    }
  }

  async function rejectRequest(id) {
    $('reqMsg').textContent = 'Rejecting...';
    $('reqMsg').classList.remove('err');

    try {
      await api(`/admin/api/requests/${id}/reject`, { method: 'POST' });
      $('reqMsg').textContent = `Rejected request #${id}`;
      await loadRequests();
    } catch (e) {
      $('reqMsg').textContent = `Error: ${e.message}`;
      $('reqMsg').classList.add('err');
    }
  }

  async function generateSetupCodeForRequestRow(requestId, flat_id, ttlMinutes = 60) {
    $('reqMsg').textContent = 'Generating setup code...';
    $('reqMsg').classList.remove('err');

    try {
      const out = await api(`/admin/api/flats/${encodeURIComponent(flat_id)}/setup-code`, {
        method: 'POST',
        body: JSON.stringify({ ttlMinutes })
      });

      $('reqMsg').textContent = `Setup code generated for ${out.flat_id}`;
      const slot = document.getElementById(`req-code-${requestId}`);

      renderInlineCode({
        slotEl: slot,
        key: `req-${requestId}`,
        code: out.code,
        expiresAt: out.expires_at
      });
    } catch (e) {
      $('reqMsg').textContent = `Error: ${e.message}`;
      $('reqMsg').classList.add('err');
    }
  }

  function initRequestActions() {
    $('reqTable').addEventListener('click', async (ev) => {
      const btn = ev.target.closest('button');
      if (!btn) return;

      const approveId = btn.getAttribute('data-approve');
      const rejectId = btn.getAttribute('data-reject');
      const setupFlat = btn.getAttribute('data-setup');

      if (approveId) { await approveRequest(Number(approveId)); return; }
      if (rejectId) { await rejectRequest(Number(rejectId)); return; }

      if (setupFlat) {
        // Find the request ID from the same row so we can render inline in that row
        const tr = btn.closest('tr');
        const requestId = tr?.children?.[0]?.textContent ? Number(tr.children[0].textContent) : null;
        if (!requestId) {
          $('reqMsg').textContent = 'Error: cannot detect request row id';
          $('reqMsg').classList.add('err');
          return;
        }
        await generateSetupCodeForRequestRow(requestId, setupFlat, 60);
        return;
      }
    });
  }

  // ---------- Flats ----------
  async function loadFlats() {
    const q = ($('flatSearch').value || '').trim().toUpperCase();
    $('flatMsg').textContent = 'Loading...';
    $('flatMsg').classList.remove('err');

    try {
      const data = await api(`/admin/api/flats?q=${encodeURIComponent(q)}`, { method: 'GET' });
      const rows = data.rows || [];

      const tbody = $('flatTable').querySelector('tbody');
      tbody.innerHTML = '';

      for (const f of rows) {
        const isDisabled = f.status === 'DISABLED';
        const banText = f.ban_until ? fmtTime(f.ban_until) : '-';
        const pill = isDisabled ? 'disabled' : 'active';

        const flatIdSafe = escapeHtml(f.flat_id);
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><b>${flatIdSafe}</b></td>
          <td><span class="pill ${pill}">${escapeHtml(f.status)}</span></td>
          <td>${f.strike_count ?? 0}</td>
          <td>${banText}</td>
          <td>${f.requires_admin_revoke ? 'YES' : 'NO'}</td>
          <td>${f.last_login_at ? fmtTime(f.last_login_at) : '-'}</td>
          <td>
            <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
              <button class="btn" data-fsetup="${flatIdSafe}">Setup Code</button>
              <button class="btn btnWarn" data-revoke="${flatIdSafe}">Revoke Ban</button>
              <button class="btn ${isDisabled ? 'btnPrimary' : 'btnDanger'}"
                      data-toggle="${flatIdSafe}" data-disabled="${isDisabled ? '1' : '0'}">
                ${isDisabled ? 'Enable' : 'Disable'}
              </button>
            </div>
            <div id="flat-code-${flatIdSafe}" style="margin-top:8px;"></div>
          </td>
        `;
        tbody.appendChild(tr);
      }

      $('flatMsg').textContent = rows.length ? `Showing ${rows.length} flat(s).` : 'No flats found.';
    } catch (e) {
      $('flatMsg').textContent = `Error: ${e.message}`;
      $('flatMsg').classList.add('err');
    }
  }

  async function generateSetupCodeForFlatRow(flat_id, ttlMinutes = 60) {
    $('flatMsg').textContent = 'Generating setup code...';
    $('flatMsg').classList.remove('err');

    try {
      const out = await api(`/admin/api/flats/${encodeURIComponent(flat_id)}/setup-code`, {
        method: 'POST',
        body: JSON.stringify({ ttlMinutes })
      });

      $('flatMsg').textContent = `Setup code generated for ${out.flat_id}`;
      const slot = document.getElementById(`flat-code-${flat_id}`);

      renderInlineCode({
        slotEl: slot,
        key: `flat-${flat_id}`,
        code: out.code,
        expiresAt: out.expires_at
      });
    } catch (e) {
      $('flatMsg').textContent = `Error: ${e.message}`;
      $('flatMsg').classList.add('err');
    }
  }

  async function revokeBan(flat_id) {
    $('flatMsg').textContent = 'Revoking ban...';
    $('flatMsg').classList.remove('err');

    try {
      await api(`/admin/api/flats/${encodeURIComponent(flat_id)}/revoke-ban`, { method: 'POST' });
      $('flatMsg').textContent = `Ban revoked for ${flat_id}`;
      await loadFlats();
    } catch (e) {
      $('flatMsg').textContent = `Error: ${e.message}`;
      $('flatMsg').classList.add('err');
    }
  }

  async function toggleDisable(flat_id, currentlyDisabled) {
    $('flatMsg').textContent = currentlyDisabled ? 'Enabling flat...' : 'Disabling flat...';
    $('flatMsg').classList.remove('err');

    try {
      await api(`/admin/api/flats/${encodeURIComponent(flat_id)}/disable`, {
        method: 'POST',
        body: JSON.stringify({ disabled: !currentlyDisabled })
      });

      $('flatMsg').textContent = currentlyDisabled ? `Enabled ${flat_id}` : `Disabled ${flat_id}`;
      await loadFlats();
    } catch (e) {
      $('flatMsg').textContent = `Error: ${e.message}`;
      $('flatMsg').classList.add('err');
    }
  }

  function initFlatActions() {
    $('flatTable').addEventListener('click', async (ev) => {
      const btn = ev.target.closest('button');
      if (!btn) return;

      const fsetup = btn.getAttribute('data-fsetup');
      const revoke = btn.getAttribute('data-revoke');
      const toggle = btn.getAttribute('data-toggle');

      if (fsetup) { await generateSetupCodeForFlatRow(fsetup, 60); return; }
      if (revoke) { await revokeBan(revoke); return; }
      if (toggle) {
        const disabled = btn.getAttribute('data-disabled') === '1';
        await toggleDisable(toggle, disabled);
        return;
      }
    });
  }

  // ---------- init ----------
  function initUI() {
    initTabs();

    // Live UI
    $('btnLoadLive')?.addEventListener('click', () => loadLive());
    $('liveSearch')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadLive(); });
    $('liveAuto')?.addEventListener('change', () => loadLive(true));
    startLiveTimer();

    // Requests UI
    $('btnLoadRequests')?.addEventListener('click', loadRequests);
    $('reqStatus')?.addEventListener('change', loadRequests);

    $('btnNewRequestToggle')?.addEventListener('click', () => {
      const box = $('newRequestBox');
      box.style.display = box.style.display === 'none' ? 'block' : 'none';
      $('newReqMsg').textContent = '';
      $('newReqMsg').classList.remove('err');
    });

    $('btnCreateRequest')?.addEventListener('click', createRequestFromUI);
    initRequestActions();

    // Flats UI
    $('btnSearchFlats')?.addEventListener('click', loadFlats);
    $('flatSearch')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadFlats(); });
    initFlatActions();
    initDbUI();
  }

  // ---------- Live (from user server snapshot via admin backend) ----------
  let liveTimer = null;

  function stopLiveTimer() {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = null;
  }

  function startLiveTimer() {
    stopLiveTimer();
    liveTimer = setInterval(async () => {
      const auto = $('liveAuto');
      // refresh only if live tab is active + checkbox enabled
      const liveTabActive = document.getElementById('tab-live')?.classList.contains('active');
      if (liveTabActive && auto?.checked) {
        await loadLive(true);
      }
    }, 2000);
  }

  function fmtRole(role) {
    if (role === 'broadcaster') return 'BROADCASTING';
    if (role === 'listener') return 'LISTENING';
    return 'IDLE';
  }

  async function loadLive(silent = false) {
    const msgEl = $('liveMsg');
    const metaEl = $('liveMeta');
    const searchEl = $('liveSearch');

    if (!silent) {
      msgEl.textContent = 'Loading...';
      msgEl.classList.remove('err');
    }

    try {
      const data = await api('/admin/api/live', { method: 'GET' });
      const snap = data.snap;

      // summary cards
      $('liveClients').textContent = snap?.totals?.wsClients ?? '-';
      $('liveStations').textContent = snap?.totals?.stations ?? '-';
      $('liveUptime').textContent = snap?.uptimeSec ?? '-';

      const ts = snap?.ts ? new Date(snap.ts).toLocaleString() : '-';
      metaEl.textContent = `Last update: ${ts}`;

      const q = (searchEl?.value || '').trim().toLowerCase();

      // stations table
      const sTbody = $('liveStationsTable')?.querySelector('tbody');
      if (sTbody) {
        sTbody.innerHTML = '';
        const stations = (snap?.stations || []);

        const filtered = q
          ? stations.filter(x =>
            String(x?.broadcaster?.flat_id || '').toLowerCase().includes(q) ||
            String(x?.broadcaster?.ip || '').toLowerCase().includes(q) ||
            (x?.listeners || []).some(l =>
              String(l?.flat_id || '').toLowerCase().includes(q) ||
              String(l?.ip || '').toLowerCase().includes(q)
            )
          )
          : stations;

        for (const st of filtered) {
          const a = st?.broadcaster?.audio || {};

          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td><b>${escapeHtml(st?.broadcaster?.flat_id || '-')}</b></td>
            <td>${escapeHtml(st?.broadcaster?.ip || '-')}</td>
            <td>${fmtTime(st?.broadcaster?.startedAt)}</td>
            <td>${(st?.listeners || []).length}</td>

            <td>${a.micOn ? 'ON' : 'OFF'}</td>
            <td>${a.sysOn ? 'ON' : 'OFF'}</td>
            <td>${a.ptt ? 'ON' : 'OFF'}</td>
            <td>${a.speaking ? 'YES' : 'NO'}</td>
          `;
          sTbody.appendChild(tr);

          // Render listeners as a second row (collapsed-style)
          if ((st?.listeners || []).length) {
            const tr2 = document.createElement('tr');
            tr2.innerHTML = `
            <td colspan="4" style="background:#fafafa;">
              <div class="small" style="font-weight:800; margin-bottom:6px;">Listeners</div>
              ${st.listeners.map(l => `
                <div style="display:flex; justify-content:space-between; gap:12px; padding:6px 0; border-top:1px solid #eee;">
                  <div><b>${escapeHtml(l.flat_id || '-')}</b></div>
                  <div>${escapeHtml(l.ip || '-')}</div>
                </div>
              `).join('')}
            </td>
          `;
            sTbody.appendChild(tr2);
          }
        }

        if (!filtered.length) {
          const tr = document.createElement('tr');
          tr.innerHTML = `<td colspan="4" class="small">No stations match your search.</td>`;
          sTbody.appendChild(tr);
        }
      }

      // clients table
      const cTbody = $('liveClientsTable')?.querySelector('tbody');
      if (cTbody) {
        cTbody.innerHTML = '';
        const clients = (snap?.clients || []);

        const filtered = q
          ? clients.filter(c =>
            String(c?.flat_id || '').toLowerCase().includes(q) ||
            String(c?.ip || '').toLowerCase().includes(q) ||
            String(c?.role || '').toLowerCase().includes(q) ||
            String(c?.listeningTo || '').toLowerCase().includes(q)
          )
          : clients;

        // show broadcasters first, then listeners, then idle
        const order = { broadcaster: 0, listener: 1, idle: 2 };
        filtered.sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9));

        for (const c of filtered) {
          const tr = document.createElement('tr');
          tr.innerHTML = `
          <td><b>${escapeHtml(c?.flat_id || '-')}</b></td>
          <td>${escapeHtml(c?.ip || '-')}</td>
          <td>${escapeHtml(fmtRole(c?.role))}</td>
          <td>${escapeHtml(c?.listeningTo || '-')}</td>
          <td>${fmtTime(c?.connectedAt)}</td>
        `;
          cTbody.appendChild(tr);
        }

        if (!filtered.length) {
          const tr = document.createElement('tr');
          tr.innerHTML = `<td colspan="5" class="small">No clients match your search.</td>`;
          cTbody.appendChild(tr);
        }
      }

      if (!silent) msgEl.textContent = 'Live data loaded.';
    } catch (e) {
      if (!silent) {
        msgEl.textContent = `Error: ${e.message}`;
        msgEl.classList.add('err');
      }
    }
  }


  initUI();

  // ---------- DB Viewer / Editor ----------
  let dbState = {
    table: null,
    cols: [],
    pkCols: [],
    rows: [],
    limit: 50,
    offset: 0,
    total: 0,
    selectedPk: null, // object of pk values
    selectedRow: null
  };

  function dbEls() {
    return {
      sel: $('dbTableSelect'),
      load: $('btnDbLoad'),
      prev: $('btnDbPrev'),
      next: $('btnDbNext'),
      page: $('dbPageInfo'),
      msg: $('dbMsg'),
      table: $('dbTable'),
      form: $('dbForm'),
      save: $('btnDbSave'),
      del: $('btnDbDelete'),
      clear: $('btnDbClear')
    };
  }

  function setDbMsg(text, isErr = false) {
    const { msg } = dbEls();
    if (!msg) return;
    msg.textContent = text || '';
    msg.classList.toggle('err', !!isErr);
  }

  async function dbLoadTables() {
    const { sel } = dbEls();
    if (!sel) return;
    try {
      const data = await api('/admin/api/db/tables', { method: 'GET' });
      sel.innerHTML = '';
      for (const t of data.tables || []) {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t;
        sel.appendChild(opt);
      }
      dbState.table = sel.value || null;
    } catch (e) {
      setDbMsg(`Error: ${e.message}`, true);
    }
  }

  async function dbLoadMeta(table) {
    const data = await api(`/admin/api/db/table/${encodeURIComponent(table)}/meta`, { method: 'GET' });
    dbState.cols = (data.cols || []).map(c => c.name);
    dbState.pkCols = data.pkCols || [];
  }

  async function dbLoadRows() {
    const { sel, page } = dbEls();
    const table = sel?.value;
    if (!table) return;

    setDbMsg('Loading...', false);

    try {
      dbState.table = table;
      await dbLoadMeta(table);

      const data = await api(`/admin/api/db/table/${encodeURIComponent(table)}/rows?limit=${dbState.limit}&offset=${dbState.offset}`, { method: 'GET' });
      dbState.rows = data.rows || [];
      dbState.total = data.total || 0;
      dbState.offset = data.offset || 0;

      dbRenderTable();
      dbRenderForm(null);

      const start = dbState.offset + 1;
      const end = dbState.offset + dbState.rows.length;
      if (page) page.textContent = dbState.total ? `${start}-${end} / ${dbState.total}` : '-';

      setDbMsg(`Loaded ${dbState.rows.length} row(s).`, false);
    } catch (e) {
      setDbMsg(`Error: ${e.message}`, true);
    }
  }

  function dbRenderTable() {
    const { table } = dbEls();
    if (!table) return;

    const theadRow = table.querySelector('thead tr');
    const tbody = table.querySelector('tbody');

    theadRow.innerHTML = '';
    tbody.innerHTML = '';

    // Header
    for (const c of dbState.cols) {
      const th = document.createElement('th');
      th.textContent = c;
      theadRow.appendChild(th);
    }

    // Body
    for (const row of dbState.rows) {
      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';

      tr.addEventListener('click', () => {
        // Build PK object if possible
        if (dbState.pkCols.length) {
          const pk = {};
          for (const k of dbState.pkCols) pk[k] = row[k];
          dbState.selectedPk = pk;
        } else {
          dbState.selectedPk = null;
        }
        dbState.selectedRow = row;
        dbRenderForm(row);
        setDbMsg(dbState.pkCols.length ? 'Row selected for edit.' : 'This table has no PK; edit/delete disabled.', !dbState.pkCols.length);
      });

      for (const c of dbState.cols) {
        const td = document.createElement('td');
        const v = row[c];
        td.textContent = v === null || v === undefined ? '' : String(v);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  function dbRenderForm(rowOrNull) {
    const { form, del } = dbEls();
    if (!form) return;

    form.innerHTML = '';

    const row = rowOrNull || {};
    for (const c of dbState.cols) {
      const wrap = document.createElement('div');

      const label = document.createElement('div');
      label.className = 'small';
      label.style.fontWeight = '800';
      label.textContent = c;

      const input = document.createElement('input');
      input.id = `dbf_${c}`;
      input.placeholder = c;

      // Show current value
      const v = row[c];
      input.value = v === null || v === undefined ? '' : String(v);

      // If editing existing row, lock PK fields (so where clause stays correct)
      if (rowOrNull && dbState.pkCols.includes(c)) {
        input.disabled = true;
        input.style.opacity = '0.7';
      }

      wrap.appendChild(label);
      wrap.appendChild(input);
      form.appendChild(wrap);
    }

    // Disable delete when no selected row or no pk
    if (del) del.disabled = !(rowOrNull && dbState.pkCols.length);
  }

  function dbCollectValues() {
    const values = {};
    for (const c of dbState.cols) {
      const el = document.getElementById(`dbf_${c}`);
      if (!el) continue;
      // Empty string -> keep as empty string; you can type NULL manually if you want,
      // but simplest is: empty means '' for TEXT fields.
      values[c] = el.value;
    }
    return values;
  }

  async function dbSave() {
    const table = dbState.table;
    if (!table) return;

    const values = dbCollectValues();

    // If row selected => UPDATE, else INSERT
    if (dbState.selectedRow && dbState.selectedPk && dbState.pkCols.length) {
      try {
        setDbMsg('Saving...', false);
        await api(`/admin/api/db/table/${encodeURIComponent(table)}/update`, {
          method: 'POST',
          body: JSON.stringify({ pk: dbState.selectedPk, values })
        });
        setDbMsg('Updated.', false);
        await dbLoadRows();
      } catch (e) {
        setDbMsg(`Error: ${e.message}`, true);
      }
    } else {
      try {
        setDbMsg('Inserting...', false);
        await api(`/admin/api/db/table/${encodeURIComponent(table)}/insert`, {
          method: 'POST',
          body: JSON.stringify({ values })
        });
        setDbMsg('Inserted.', false);
        await dbLoadRows();
      } catch (e) {
        setDbMsg(`Error: ${e.message}`, true);
      }
    }
  }

  async function dbDelete() {
    const table = dbState.table;
    if (!table) return;

    if (!dbState.selectedPk || !dbState.pkCols.length) {
      setDbMsg('Select a row (with primary key) to delete.', true);
      return;
    }

    const ok = confirm('Delete this row? This cannot be undone.');
    if (!ok) return;

    try {
      setDbMsg('Deleting...', false);
      await api(`/admin/api/db/table/${encodeURIComponent(table)}/delete`, {
        method: 'POST',
        body: JSON.stringify({ pk: dbState.selectedPk })
      });
      setDbMsg('Deleted.', false);
      await dbLoadRows();
    } catch (e) {
      setDbMsg(`Error: ${e.message}`, true);
    }
  }

  function dbClearForm() {
    dbState.selectedPk = null;
    dbState.selectedRow = null;
    dbRenderForm(null);
    setDbMsg('Cleared form. Saving now will INSERT a new row.', false);
  }

  function initDbUI() {
    const { sel, load, prev, next, save, del, clear } = dbEls();
    if (!sel) return; // DB tab not present

    load?.addEventListener('click', async () => {
      dbState.offset = 0;
      await dbLoadRows();
    });

    sel?.addEventListener('change', async () => {
      dbState.offset = 0;
      await dbLoadRows();
    });

    prev?.addEventListener('click', async () => {
      dbState.offset = Math.max(0, dbState.offset - dbState.limit);
      await dbLoadRows();
    });

    next?.addEventListener('click', async () => {
      if (dbState.offset + dbState.limit < dbState.total) {
        dbState.offset += dbState.limit;
        await dbLoadRows();
      }
    });

    save?.addEventListener('click', dbSave);
    del?.addEventListener('click', dbDelete);
    clear?.addEventListener('click', dbClearForm);

    // initial load
    dbLoadTables().then(() => dbLoadRows());
  }


  // ---------- live WS monitoring ----------
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/admin/ws`);

  ws.onmessage = (ev) => {
    try { renderMonitor(JSON.parse(ev.data)); } catch { }
  };

  ws.onclose = () => {
    const memEl = $('mem');
    if (memEl) memEl.textContent = 'Disconnected. Refresh page.';
    setStatus('warn', 'WARNING: Disconnected from server', '⚠️');
  };

  window.addEventListener('beforeunload', () => {
    stopLiveTimer();
  });

})();
