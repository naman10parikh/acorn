/* acorn cockpit — vanilla-JS SPA (G1 · COCKPIT · PLAN §10).
   4 views, all on REAL data (the same artifacts the CLI/MCP produce):
     1 Brain   — render brain/*.md + a search box over `acorn brain search` (Memory component)
     2 Runs    — tail logs/runs.jsonl with model · duration · the DB verdict · tool calls
     3 Evals   — the golden-task pyramid pass/fail grid + L1 live state + acceptance badge
     4 Ask     — run a $0/no-key acorn verb (brain | rls-lint | schema --dry-run) on a brief/SQL
   No framework, no build step. marked.js (CDN) is the only vendor — brain markdown render only. */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function api(path, opts) {
  const r = await fetch(path, opts);
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { error: text || ("HTTP " + r.status) }; }
  if (!r.ok && json.error == null) json.error = "HTTP " + r.status;
  return json;
}

function toast(msg, bad = false) {
  const t = $("#toast"); t.textContent = msg; t.className = "show" + (bad ? " bad" : "");
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.className = ""), 2600);
}

// ---- view registry -----------------------------------------------------------
const VIEWS = []; // {id, label, icon, sub?, render(container)}
function register(v) { VIEWS.push(v); }

// =============================================================== 1 · BRAIN ====
register({
  id: "brain", label: "Brain", icon: "ph-brain", sub: "expertise",
  async render(c) {
    c.innerHTML = "";
    c.appendChild(viewHead("Brain", "acorn's expertise, legible — the six Wave-R artifacts the employee reasons from. Search runs the same BM25 backing as <code>acorn brain search</code>."));

    const searchPanel = el("div", "panel");
    searchPanel.innerHTML = `<div class="panel-body"><div style="display:flex;gap:10px">
      <input id="brain-q" class="field" placeholder="Search the brain — e.g. filtered ANN over-filter, lock_timeout, halfvec…" autocomplete="off">
      <button id="brain-go" class="btn primary"><i class="ph ph-magnifying-glass"></i> Search</button></div>
      <div id="brain-hits"></div></div>`;
    c.appendChild(searchPanel);

    const grid = el("div", "panel");
    grid.innerHTML = `<div class="panel-head"><i class="ph ph-books"></i> Artifacts</div>
      <div class="panel-body"><div class="brain-grid">
        <div id="brain-list" class="brain-list"><div class="loading">loading brain…</div></div>
        <div id="brain-doc" class="md"><div class="empty">Pick an artifact to read it.</div></div>
      </div></div>`;
    c.appendChild(grid);

    const data = await api("/api/brain");
    const list = $("#brain-list", c);
    if (data.error) { list.innerHTML = `<div class="empty">${esc(data.error)}</div>`; return; }
    list.innerHTML = "";
    data.items.forEach((it, i) => {
      const li = el("div", "brain-li");
      li.innerHTML = `<div class="t">${esc(it.title)}</div><div class="f">${esc(it.file)} · ${(it.size / 1024).toFixed(1)}kB</div>`;
      li.onclick = () => { list.querySelectorAll(".brain-li").forEach((x) => x.classList.remove("active")); li.classList.add("active"); openBrain(it.file, c); };
      list.appendChild(li);
      if (i === 0) li.click();
    });

    const doSearch = async () => {
      const q = $("#brain-q", c).value.trim(); if (!q) return;
      const box = $("#brain-hits", c); box.innerHTML = `<div class="loading">searching…</div>`;
      const res = await api("/api/brain/search?q=" + encodeURIComponent(q));
      if (res.error) { box.innerHTML = `<div class="empty">${esc(res.error)}</div>`; return; }
      if (!res.hits.length) { box.innerHTML = `<div class="hint">No brain hits for “${esc(q)}”.</div>`; return; }
      box.innerHTML = `<div style="margin-top:12px;display:flex;flex-direction:column;gap:6px">` +
        res.hits.map((h) => `<div class="brain-li" data-f="${esc(h.path.replace("brain/", ""))}" style="cursor:pointer">
          <div class="t">${esc(h.path)} <span class="chip dim" style="float:right">score ${h.score.toFixed(2)}</span></div></div>`).join("") + `</div>`;
      box.querySelectorAll("[data-f]").forEach((node) => node.onclick = () => openBrain(node.dataset.f, c));
    };
    $("#brain-go", c).onclick = doSearch;
    $("#brain-q", c).onkeydown = (e) => { if (e.key === "Enter") doSearch(); };
  },
});

async function openBrain(file, c) {
  const doc = $("#brain-doc", c); if (!doc) return;
  doc.innerHTML = `<div class="loading">loading ${esc(file)}…</div>`;
  const res = await api("/api/brain/file?p=" + encodeURIComponent(file));
  if (res.error) { doc.innerHTML = `<div class="empty">${esc(res.error)}</div>`; return; }
  // render markdown; map [[wikilinks]] to clickable in-cockpit nav.
  let md = res.markdown.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, (_, name) => `[${name}](#wiki:${encodeURIComponent(name)})`);
  doc.innerHTML = window.marked ? window.marked.parse(md) : `<pre>${esc(res.markdown)}</pre>`;
  doc.querySelectorAll('a[href^="#wiki:"]').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); const name = decodeURIComponent(a.getAttribute("href").slice(6)); resolveWiki(name, c); };
  });
  doc.scrollTop = 0;
}
async function resolveWiki(name, c) {
  // wikilink → brain file: try "<NAME>.md", then the MOC, else toast.
  const data = await api("/api/brain");
  const hit = (data.items || []).find((it) => it.file.replace(/\.md$/, "").toUpperCase() === name.toUpperCase() || it.title.toUpperCase().includes(name.toUpperCase()));
  if (hit) { openBrain(hit.file, c); $("#brain-list .brain-li", c)?.classList?.remove("active"); }
  else toast("No brain note named “" + name + "”", true);
}

// ================================================================ 2 · RUNS ====
register({
  id: "runs", label: "Run log", icon: "ph-pulse", sub: "observability",
  async render(c) {
    c.innerHTML = "";
    c.appendChild(viewHead("Run log", "What the employee did. Each acorn run appends a JSONL record — model · duration · tool calls · the <strong>DB verdict</strong> (migration safety class · lock-risk class · RLS-coverage %). Append-only audit trail."));
    const data = await api("/api/runs");
    const s = data.summary || { total: 0 };

    const dist = el("div", "panel");
    dist.innerHTML = `<div class="panel-head"><i class="ph ph-chart-bar"></i> Distribution — ${s.total || 0} run(s)</div>
      <div class="panel-body">
        <div class="dist-row" style="margin-bottom:10px">${chips(s.by_safety_class, safetyClass)}</div>
        <div class="dist-row" style="margin-bottom:10px">${chips(s.by_lock_class, () => "chip dim", "lock: ")}</div>
        <div style="font-size:12.5px;color:var(--ink-3)">
          <strong style="color:var(--ink)">${s.state_mutating_runs || 0}</strong> state-mutating (carried a branch id) ·
          avg RLS coverage <strong style="color:var(--ink)">${s.avg_rls_coverage_pct == null ? "n/a" : s.avg_rls_coverage_pct + "%"}</strong></div>
      </div>`;
    c.appendChild(dist);

    const tail = data.tail || [];
    const tbl = el("div", "panel");
    let rows = tail.length ? tail.slice().reverse().map((r) => {
      const v = r.verdict || {};
      return `<tr>
        <td class="ts">${esc((r.ts || "").replace("T", " ").replace(/\.\d+Z$/, "Z"))}</td>
        <td><code>${esc(r.tool || "?")}</code></td>
        <td><span class="${safetyClass(v.safety_class)}">${esc(v.safety_class || "—")}</span></td>
        <td>${esc(v.lock_class || "none")}</td>
        <td>${v.rls_coverage_pct == null ? "—" : v.rls_coverage_pct + "%"}</td>
        <td>${r.branch ? `<code>${esc(r.branch)}</code>` : "—"}</td>
        <td class="verdict-detail">${esc((r.detail || "").slice(0, 120))}</td></tr>`;
    }).join("") : `<tr><td colspan="7" class="empty">No runs yet — run an acorn command (it appends here).</td></tr>`;
    tbl.innerHTML = `<div class="panel-head"><i class="ph ph-list-bullets"></i> Recent runs</div>
      <div class="panel-body" style="padding:0"><table class="table">
        <thead><tr><th>when</th><th>tool</th><th>verdict</th><th>lock</th><th>RLS cov</th><th>branch</th><th>detail</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
    c.appendChild(tbl);
  },
});
function safetyClass(k) { return k === "safe" ? "chip ok" : k === "blocked" ? "chip bad" : k === "rewritten" ? "chip warn" : "chip dim"; }
function chips(obj, classFn, prefix = "") {
  obj = obj || {};
  const keys = Object.keys(obj);
  if (!keys.length) return `<span class="chip dim">none</span>`;
  return keys.map((k) => `<span class="${classFn(k)}">${esc(prefix + k)} · ${obj[k]}</span>`).join("");
}

// =============================================================== 3 · EVALS ====
register({
  id: "evals", label: "Evals", icon: "ph-check-square", sub: "immune system",
  async render(c) {
    c.innerHTML = "";
    c.appendChild(viewHead("Eval scores", "Is it working? The golden-task pyramid (15 tasks from real incidents) — L1 structural ($0, no DB) + L2 behavioral. The CI-blocking subset gates merge; the flagship invariant: <strong>RLS tasks run as the un-privileged role</strong>."));
    const data = await api("/api/evals");

    // acceptance badge + L1 live state (shape: {passed, total, allPass, exit})
    const l1 = data.l1 || {};
    const l1pass = typeof l1.passed === "number" ? l1.passed : null, l1total = l1.total ?? null;
    const l1ok = l1.allPass === true || (l1pass != null && l1total != null && l1pass === l1total) || l1.exit === 0;
    const badge = el("div", "panel");
    badge.innerHTML = `<div class="panel-body" style="display:flex;align-items:center;gap:18px;flex-wrap:wrap">
      <div><div style="font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:var(--ink-4)">Acceptance test (G1)</div>
        <div style="font-family:'Instrument Serif',serif;font-size:22px;color:var(--ink)">acorn schema → migrations applied + RLS verified</div></div>
      <div style="margin-left:auto;display:flex;gap:10px;align-items:center">
        <span class="chip ${l1ok ? "ok" : "warn"}">L1 ${typeof l1pass === "number" ? `${l1pass}/${l1total}` : (l1.exit === 0 ? "pass" : "see CI")}</span>
        <span class="chip l2">gated in CI</span></div></div>`;
    c.appendChild(badge);

    const tasks = data.tasks || [];
    const grid = el("div", "panel");
    if (!tasks.length) {
      grid.innerHTML = `<div class="panel-body"><div class="empty">Could not load the golden-task manifest. (eval/eval.py --list --json)</div></div>`;
    } else {
      const cells = tasks.map((t) => {
        const hamel = t.hamel || "";
        const ci = t.ci_blocking, db = t.needs_db;
        const cls = ci ? "pass" : "skip"; // visual: CI-blocking tasks are the green merge gate; non-blocking are nightly/plan
        return `<div class="eval-cell ${cls}">
          <div class="id">${esc(t.id)}</div>
          <div class="ttl">${esc((t.title || "").replace(/^[^—]*—\s*/, ""))}</div>
          <div class="meta">
            <span class="chip ${hamel.includes("L2") ? "l2" : "l1"}">${esc(hamel)}</span>
            ${ci ? `<span class="chip ok">CI</span>` : `<span class="chip dim">nightly</span>`}
            ${db ? `<span class="chip warn">needs DB</span>` : ``}
          </div></div>`;
      }).join("");
      grid.innerHTML = `<div class="panel-head"><i class="ph ph-list-checks"></i> Golden tasks (${tasks.length}) — <span style="color:var(--ink-4);font-weight:400">green = CI merge gate</span></div>
        <div class="panel-body"><div class="eval-grid">${cells}</div></div>`;
    }
    c.appendChild(grid);
  },
});

// ================================================================= 4 · ASK ====
register({
  id: "ask", label: "Ask", icon: "ph-chat-teardrop-dots", sub: "talk to acorn",
  async render(c) {
    c.innerHTML = "";
    c.appendChild(viewHead("Ask the employee", "Run acorn against a brief or some SQL. The <strong>brain</strong> + <strong>RLS-lint</strong> paths are $0, no key, no DB. The <strong>schema</strong> path is a dry-run (derives tenancy + tables + safe migrations, never applies — that needs a Docker Postgres)."));

    const panel = el("div", "panel");
    panel.innerHTML = `<div class="panel-body">
      <div style="margin-bottom:12px"><div class="seg" id="ask-mode">
        <button data-m="brain" class="on">Brain search</button>
        <button data-m="rls-lint">RLS lint</button>
        <button data-m="schema">Schema (dry-run)</button>
      </div></div>
      <textarea id="ask-in" class="field" placeholder="filtered ANN over-filter"></textarea>
      <div style="display:flex;align-items:center;gap:12px;margin-top:12px">
        <button id="ask-run" class="btn primary"><i class="ph ph-paper-plane-tilt"></i> Run</button>
        <span id="ask-hint" class="hint"></span>
      </div>
      <div id="ask-out" class="ask-out" style="display:none"></div></div>`;
    c.appendChild(panel);

    let mode = "brain";
    const placeholders = {
      brain: "filtered ANN over-filter",
      "rls-lint": "create table public.tickets (id uuid primary key, org_id uuid, body text);",
      schema: "a multi-tenant helpdesk: orgs have members; members file tickets; tickets have messages",
    };
    const hints = {
      brain: "BM25 over the six brain artifacts — same backing as the CLI.",
      "rls-lint": "Deterministic SQL lint (P1–P9). Paste a CREATE TABLE; it flags missing RLS, unwrapped auth.uid(), missing WITH CHECK…",
      schema: "Dry-run: tenancy decision → tables → safe migrations → self-check. No DB, no key.",
    };
    const setMode = (m) => {
      mode = m; $("#ask-mode", c).querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.m === m));
      $("#ask-in", c).placeholder = placeholders[m]; $("#ask-hint", c).textContent = hints[m];
    };
    $("#ask-mode", c).querySelectorAll("button").forEach((b) => b.onclick = () => setMode(b.dataset.m));
    setMode("brain");

    $("#ask-run", c).onclick = async () => {
      const input = $("#ask-in", c).value.trim() || placeholders[mode];
      const out = $("#ask-out", c); out.style.display = "block"; out.textContent = "running acorn " + mode + "…";
      const btn = $("#ask-run", c); btn.disabled = true;
      try {
        const res = await api("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, input }) });
        if (res.error) { out.innerHTML = `<span style="color:var(--bad)">${esc(res.error)}</span>`; toast(res.error, true); }
        else {
          // highlight brain citations (brain/*.md, SCENARIO #N, Pn) in the output
          let o = esc(res.output || "(no output)");
          o = o.replace(/(brain\/[A-Za-z0-9_\-]+\.md|SCENARIO #\d+|CVE-\d{4}-\d+|\bP\d{1,2}\b)/g, '<span class="cite">$1</span>');
          out.innerHTML = o + (res.ok === false ? `\n\n<span style="color:var(--warn)">[exit non-zero — for rls-lint that means a violation was found, which is correct]</span>` : "");
        }
      } finally { btn.disabled = false; }
    };
    $("#ask-in", c).onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#ask-run", c).click(); };
  },
});

// ---- shell: nav rail + router + stats ----------------------------------------
function viewHead(title, sub) { const h = el("div", "view-head"); h.innerHTML = `<h1>${esc(title)}</h1><p>${sub}</p>`; return h; }

function buildRail() {
  const rail = $("#nav-rail");
  VIEWS.forEach((v) => {
    const item = el("div", "rail-item"); item.dataset.id = v.id;
    item.innerHTML = `<i class="ph ${v.icon}"></i><span>${esc(v.label)}</span>${v.sub ? `<span class="sub">${esc(v.sub)}</span>` : ""}`;
    item.onclick = () => go(v.id);
    rail.insertBefore(item, $(".rail-foot", rail));
  });
}

let current = null;
async function go(id) {
  const v = VIEWS.find((x) => x.id === id) || VIEWS[0];
  current = v.id;
  document.querySelectorAll(".rail-item").forEach((n) => n.classList.toggle("active", n.dataset.id === v.id));
  if (location.hash !== "#" + v.id) history.replaceState(null, "", "#" + v.id);
  const stage = $("#app-view"); stage.innerHTML = `<div class="loading">loading ${esc(v.label)}…</div>`;
  try { await v.render(stage); } catch (e) { stage.innerHTML = `<div class="empty">view error: ${esc(e.message || e)}</div>`; }
}

async function refreshStats() {
  try {
    const [runs, evals] = await Promise.all([api("/api/runs"), api("/api/evals")]);
    const s = runs.summary || {};
    $("#stat-runs").textContent = s.total ?? 0;
    $("#stat-safe").textContent = (s.by_safety_class && s.by_safety_class.safe) || 0;
    $("#stat-cov").textContent = s.avg_rls_coverage_pct == null ? "—" : s.avg_rls_coverage_pct + "%";
    const l1 = evals.l1 || {};
    const p = l1.passed, t = l1.total;
    $("#stat-l1").textContent = (typeof p === "number" && typeof t === "number") ? `${p}/${t}` : (l1.allPass || l1.exit === 0 ? "✓" : "—");
  } catch { /* stats are best-effort */ }
}

window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (e.key === "/") { e.preventDefault(); go("brain").then(() => $("#brain-q")?.focus()); }
  const n = Number(e.key); if (n >= 1 && n <= VIEWS.length) go(VIEWS[n - 1].id);
});

buildRail();
go((location.hash || "#brain").slice(1));
refreshStats();
