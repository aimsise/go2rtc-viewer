// verify-ui :: VIEWER regression check (web/index.html, app.js)
// Run via: playwright-cli run-code "$(cat .claude/skills/verify-ui/checks/viewer.js)"
// Signature is `async page => {...}` executed in NODE context by playwright-cli's run-code.
// Use page.evaluate(...) for DOM access and page.waitForTimeout(ms) for delays.
// Returns JSON.stringify(results); each check is {pass:boolean, detail:string}.
// NON-DESTRUCTIVE: only reads DOM + collects console errors. No clicks that save/delete.
async page => {
  const results = {};
  const add = (name, pass, detail) => { results[name] = { pass: !!pass, detail: String(detail) }; };

  // ── Console-clean: attach a collector, then (re)load so we capture page errors. ──
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  // Pin language to JA before any page script runs so a locale-dependent default
  // (navigator.language) doesn't flip the JA assertions below.
  await page.addInitScript(() => { try { localStorage.setItem('seccam.lang', 'ja'); } catch (e) {} });

  await page.goto('http://localhost:8000/web/index.html', { waitUntil: 'networkidle' });
  // app.js probes go2rtc + builds panes asynchronously; give it a beat to settle.
  await page.waitForTimeout(1500);

  // ── 1) Header-actions order: [layout-group, conn-status, reload-btn, view-switch, help] ──
  {
    const order = await page.evaluate(() => {
      const ha = document.querySelector('.app-header .header-actions');
      if (!ha) return null;
      // Map each direct child to a stable token by its identifying class/id.
      return Array.from(ha.children).map((el) => {
        if (el.classList.contains('layout-group')) return 'layout-group';
        if (el.id === 'conn-status') return 'conn-status';
        if (el.id === 'reload-btn') return 'reload-btn';
        if (el.classList.contains('view-switch')) return 'view-switch';
        if (el.classList.contains('lang-switch')) return 'lang-switch';
        if (el.classList.contains('help')) return 'help';
        return el.tagName.toLowerCase() + '?';
      });
    });
    const want = ['layout-group', 'conn-status', 'reload-btn', 'view-switch', 'lang-switch', 'help'];
    const ok = order && order.join(',') === want.join(',');
    add('header_order', ok, ok ? `order=${want.join(' > ')}` : `got=${JSON.stringify(order)} want=${JSON.stringify(want)}`);
  }

  // ── 2) All four layout buttons exist (data-layout 1/2/4/6) ──
  {
    const have = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#layout-switch .layout-btn[data-layout]'))
        .map((b) => b.dataset.layout)
    );
    const want = ['1', '2', '4', '6'];
    const missing = want.filter((w) => !have.includes(w));
    add('layout_buttons', missing.length === 0, missing.length === 0 ? `found ${have.join('/')}` : `missing data-layout: ${missing.join(',')}`);
  }

  // ── 3) Pane template [data-role] hooks all present ──
  {
    const required = ['video-wrap', 'camera-select', 'addr', 'quality-badge',
      'placeholder', 'placeholder-text', 'overlay', 'overlay-text',
      'hd-toggle', 'snapshot', 'fullscreen'];
    const missing = await page.evaluate((req) => {
      // Prefer a live pane; fall back to the <template> content if grid is empty.
      let root = document.querySelector('#grid .pane');
      if (!root) {
        const tpl = document.getElementById('pane-template');
        root = tpl && tpl.content ? tpl.content : null;
      }
      if (!root) return ['<no pane and no template>'];
      return req.filter((r) => !root.querySelector(`[data-role="${r}"]`));
    }, required);
    add('pane_data_roles', missing.length === 0, missing.length === 0 ? `all ${required.length} hooks present` : `MISSING data-role: ${missing.join(', ')}`);
  }

  // ── 4) [hidden] gotcha guard: capture overlay must be display:none when hidden ──
  // Re-introducing the bug (dropping .cam-overlay[hidden]{display:none}) makes a
  // hidden flex overlay STAY VISIBLE. We force a pane's overlay hidden and assert it.
  {
    const r = await page.evaluate(() => {
      let ov = document.querySelector('#grid .pane [data-role="overlay"]');
      let madeTransient = false;
      if (!ov) {
        // No live pane: instantiate template once into an offscreen host to test CSS.
        const tpl = document.getElementById('pane-template');
        if (!tpl) return { ok: false, detail: 'no overlay and no pane-template' };
        const host = document.createElement('div');
        host.style.position = 'absolute'; host.style.left = '-9999px';
        host.appendChild(tpl.content.cloneNode(true));
        document.body.appendChild(host);
        ov = host.querySelector('[data-role="overlay"]');
        madeTransient = true;
        host.dataset.verifyTransient = '1';
      }
      if (!ov) return { ok: false, detail: 'overlay element not found' };
      ov.hidden = true; // emulate JS hiding the overlay
      const disp = getComputedStyle(ov).display;
      const ok = disp === 'none';
      // clean up any transient host we created
      if (madeTransient) {
        const host = document.querySelector('[data-verify-transient="1"]');
        if (host) host.remove();
      } else {
        // restore: viewer leaves overlay hidden by default, so keep it hidden (no-op).
      }
      return { ok, detail: `computed display when [hidden] = "${disp}"` };
    });
    add('overlay_hidden_guard', r.ok, r.detail);
  }

  // ── 5) conn-status resolves to conn-status--ok (go2rtc reachable) ──
  {
    // app.js sets --ok only after a successful probe; poll briefly.
    let kind = 'unknown';
    for (let i = 0; i < 10; i++) {
      kind = await page.evaluate(() => {
        const el = document.getElementById('conn-status');
        if (!el) return '<missing>';
        const m = Array.from(el.classList).find((c) => c.startsWith('conn-status--'));
        return m ? m.replace('conn-status--', '') : '<none>';
      });
      if (kind === 'ok') break;
      await page.waitForTimeout(500);
    }
    add('conn_status_ok', kind === 'ok', `conn-status--${kind}` + (kind !== 'ok' ? ' (is go2rtc up on :1984?)' : ''));
  }

  // ── 6) HD label text is exactly "画質HD" ──
  {
    const r = await page.evaluate(() => {
      let btn = document.querySelector('#grid .pane [data-role="hd-toggle"]');
      let txt;
      if (btn) {
        txt = (btn.querySelector('.btn-text') || btn).textContent.trim();
      } else {
        const tpl = document.getElementById('pane-template');
        const t = tpl && tpl.content.querySelector('[data-role="hd-toggle"] .btn-text');
        txt = t ? t.textContent.trim() : null;
      }
      return txt;
    });
    add('hd_label', r === '画質HD', `hd-toggle label = ${JSON.stringify(r)} (want "画質HD")`);
  }

  // ── 7) When a pane is live, <video-stream> is firstElementChild of .pane-video-wrap ──
  // Informational unless at least one camera is configured+live. We don't force a stream.
  {
    const r = await page.evaluate(() => {
      const wraps = Array.from(document.querySelectorAll('#grid .pane-video-wrap'));
      const live = wraps.filter((w) => w.classList.contains('is-live'));
      if (live.length === 0) return { status: 'skip', detail: 'no live pane (no camera configured/streaming) — contract not exercised' };
      const bad = live.filter((w) => {
        const first = w.firstElementChild;
        return !first || first.tagName.toLowerCase() !== 'video-stream';
      });
      return bad.length === 0
        ? { status: 'pass', detail: `${live.length} live pane(s): <video-stream> is firstElementChild` }
        : { status: 'fail', detail: `${bad.length} live pane(s) where firstElementChild is NOT <video-stream>` };
    });
    if (r.status === 'skip') add('video_stream_firstchild', true, 'SKIP: ' + r.detail);
    else add('video_stream_firstchild', r.status === 'pass', r.detail);
  }

  // ── 8) Language toggle (i18n): EN switches the UI to English, JA restores ──
  {
    const reloadText = () => page.evaluate(() => {
      const b = document.querySelector('#reload-btn .btn-text');
      return b ? b.textContent.trim() : '<missing>';
    });
    const haveBtns = await page.evaluate(() =>
      !!document.querySelector('.lang-switch .lang-btn[data-lang="en"]') &&
      !!document.querySelector('.lang-switch .lang-btn[data-lang="ja"]'));
    if (!haveBtns) {
      add('lang_toggle', false, 'lang-switch buttons missing');
    } else {
      const ja0 = await reloadText();
      await page.evaluate(() => document.querySelector('.lang-switch .lang-btn[data-lang="en"]').click());
      await page.waitForTimeout(120);
      const en1 = await reloadText();
      const langAttr = await page.evaluate(() => document.documentElement.getAttribute('lang'));
      await page.evaluate(() => document.querySelector('.lang-switch .lang-btn[data-lang="ja"]').click());
      await page.waitForTimeout(120);
      const ja1 = await reloadText();
      const ok = ja0 === '更新' && en1 === 'Reload' && langAttr === 'en' && ja1 === '更新';
      add('lang_toggle', ok, `ja="${ja0}" -> en="${en1}" (lang=${langAttr}) -> ja="${ja1}" (want 更新 / Reload / en / 更新)`);
    }
  }

  // ── Console-clean (favicon 404 etc. would surface here) ──
  add('console_clean', consoleErrors.length === 0,
    consoleErrors.length === 0 ? 'no console errors / pageerrors' : `${consoleErrors.length} error(s): ` + consoleErrors.slice(0, 5).join(' | '));

  const failed = Object.entries(results).filter(([, v]) => !v.pass).map(([k]) => k);
  return JSON.stringify({ page: 'viewer', ok: failed.length === 0, failed, checks: results }, null, 2);
}
