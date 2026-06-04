// verify-ui :: MANAGEMENT regression check (web/streams.html, streams.js)
// Run via: playwright-cli run-code "$(cat .claude/skills/verify-ui/checks/management.js)"
// Signature is `async page => {...}` executed in NODE context by playwright-cli's run-code.
// Use page.evaluate(...) for DOM access and page.waitForTimeout(ms) for delays.
// Returns JSON.stringify(results); each check is {pass:boolean, detail:string}.
// NON-DESTRUCTIVE: switches tabs + toggles add-form open/closed only. NEVER saves
// config and NEVER deletes a stream.
async page => {
  const results = {};
  const add = (name, pass, detail) => { results[name] = { pass: !!pass, detail: String(detail) }; };

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  // Pin language to JA before any page script runs so a locale-dependent default
  // (navigator.language) doesn't flip the JA assertions below.
  await page.addInitScript(() => { try { localStorage.setItem('seccam.lang', 'ja'); } catch (e) {} });

  await page.goto('http://localhost:8000/web/streams.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500); // streams.js probes version/streams + wires tabs

  // ── 1) Header-actions order: [conn-status, reload-btn, view-switch, help] (no layout-group) ──
  {
    const order = await page.evaluate(() => {
      const ha = document.querySelector('.app-header .header-actions');
      if (!ha) return null;
      return Array.from(ha.children).map((el) => {
        if (el.id === 'conn-status') return 'conn-status';
        if (el.id === 'reload-btn') return 'reload-btn';
        if (el.classList.contains('view-switch')) return 'view-switch';
        if (el.classList.contains('lang-switch')) return 'lang-switch';
        if (el.classList.contains('help')) return 'help';
        if (el.classList.contains('layout-group')) return 'layout-group(!unexpected)';
        return el.tagName.toLowerCase() + '?';
      });
    });
    const want = ['conn-status', 'reload-btn', 'view-switch', 'lang-switch', 'help'];
    const ok = order && order.join(',') === want.join(',');
    add('header_order', ok, ok ? `order=${want.join(' > ')}` : `got=${JSON.stringify(order)} want=${JSON.stringify(want)}`);
  }

  // ── 2) The four tabs switch panels: only the active panel visible, others [hidden] ──
  {
    const tabs = ['streams', 'config', 'log', 'net'];
    const perTab = {};
    let allOk = true;
    for (const t of tabs) {
      // Drive the real handler (delegated click on #tabbar). Non-destructive.
      const clicked = await page.evaluate((name) => {
        const btn = document.querySelector(`.tabbar .tab[data-tab="${name}"]`);
        if (!btn) return false;
        btn.click();
        return true;
      }, t);
      if (!clicked) { perTab[t] = 'tab button missing'; allOk = false; continue; }
      await page.waitForTimeout(150);
      const state = await page.evaluate((name) => {
        const panels = ['streams', 'config', 'log', 'net'];
        const vis = {};
        for (const p of panels) {
          const el = document.getElementById('panel-' + p);
          if (!el) { vis[p] = 'MISSING'; continue; }
          const disp = getComputedStyle(el).display;
          vis[p] = { hidden: el.hidden, display: disp };
        }
        const tabBtn = document.querySelector(`.tabbar .tab[data-tab="${name}"]`);
        return { vis, active: tabBtn ? tabBtn.classList.contains('is-active') : null };
      }, t);
      // Active panel must be visible (display != none, not hidden); all others hidden+none.
      const active = state.vis[t];
      const activeVisible = active && active.hidden === false && active.display !== 'none';
      const othersHidden = Object.entries(state.vis)
        .filter(([k]) => k !== t)
        .every(([, v]) => v && v.hidden === true && v.display === 'none');
      const tabActive = state.active === true;
      const ok = activeVisible && othersHidden && tabActive;
      if (!ok) allOk = false;
      perTab[t] = ok ? 'ok' : `activeVisible=${activeVisible} othersHidden=${othersHidden} tabIsActive=${tabActive} ${JSON.stringify(state.vis)}`;
    }
    // restore to the streams tab so the page is left in its default view
    await page.evaluate(() => { const b = document.querySelector('.tabbar .tab[data-tab="streams"]'); if (b) b.click(); });
    await page.waitForTimeout(100);
    add('tab_switching', allOk, JSON.stringify(perTab));
  }

  // ── 3) [hidden] gotcha guard: .add-form must be display:none when hidden ──
  // (.add-form has display:grid; without .add-form[hidden]{display:none} it'd stay open.)
  {
    const r = await page.evaluate(async () => {
      const form = document.getElementById('add-form');
      if (!form) return { ok: false, detail: 'add-form missing' };
      const startedHidden = form.hidden;
      // Ensure hidden, then measure.
      form.hidden = true;
      const dispHidden = getComputedStyle(form).display;
      // Sanity: when shown it should be a layout box (grid), proving the guard is what hides it.
      form.hidden = false;
      const dispShown = getComputedStyle(form).display;
      // restore original state (default is closed/hidden)
      form.hidden = startedHidden === undefined ? true : startedHidden;
      if (form.hidden !== true) form.hidden = true;
      return { ok: dispHidden === 'none', dispHidden, dispShown };
    });
    add('add_form_hidden_guard', r.ok, `display when [hidden]="${r.dispHidden}", when shown="${r.dispShown}" (want hidden:none)`);
  }

  // ── 4) Card template [data-role] hooks all present ──
  {
    const required = ['name', 'online', 'online-text', 'status', 'status-text',
      'codecs', 'source', 'watch', 'info', 'probe', 'links', 'net', 'delete'];
    const missing = await page.evaluate((req) => {
      let root = document.querySelector('#stream-grid .stream-card');
      if (!root) {
        const tpl = document.getElementById('card-template');
        root = tpl && tpl.content ? tpl.content : null;
      }
      if (!root) return ['<no card and no template>'];
      return req.filter((r) => !root.querySelector(`[data-role="${r}"]`));
    }, required);
    add('card_data_roles', missing.length === 0, missing.length === 0 ? `all ${required.length} hooks present` : `MISSING data-role: ${missing.join(', ')}`);
  }

  // ── 5) conn-status resolves to conn-status--ok ──
  {
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

  // ── 6) version-info populated (streams.js fills it from go2rtc) ──
  {
    let txt = '';
    for (let i = 0; i < 10; i++) {
      txt = await page.evaluate(() => {
        const el = document.getElementById('version-info');
        return el ? el.textContent.trim() : '<missing>';
      });
      // initial placeholder is "go2rtc に接続中…"; consider populated once it changes/non-empty & not the placeholder
      if (txt && txt !== 'go2rtc に接続中…' && txt !== '<missing>') break;
      await page.waitForTimeout(500);
    }
    const ok = !!txt && txt !== '<missing>' && txt !== 'go2rtc に接続中…';
    add('version_info', ok, `version-info = ${JSON.stringify(txt)}` + (ok ? '' : ' (still placeholder — is go2rtc reachable?)'));
  }

  // ── Language toggle (i18n): EN switches the UI to English, JA restores ──
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

  add('console_clean', consoleErrors.length === 0,
    consoleErrors.length === 0 ? 'no console errors / pageerrors' : `${consoleErrors.length} error(s): ` + consoleErrors.slice(0, 5).join(' | '));

  const failed = Object.entries(results).filter(([, v]) => !v.pass).map(([k]) => k);
  return JSON.stringify({ page: 'management', ok: failed.length === 0, failed, checks: results }, null, 2);
}
