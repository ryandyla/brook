/**
 * Cloudflare Worker / Pages _worker.js
 * - GET /?phone=<number>&demo=1
 * - Renders HTML with caller details
 * - Server-side fetch to your data API using API_TOKEN
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const q = url.searchParams;
    const demo = q.get("demo") === "1";

    // Normalize and validate phone
    const rawPhone = (q.get("phone") || "").trim();
    const normalized = normalizePhone(rawPhone, env.DEFAULT_COUNTRY || "+1");

    // If demo mode or no phone, show a friendly form
    if (!normalized && !demo) {
      return htmlResponse(renderPage({
        title: "Caller Pop",
        content: renderForm(rawPhone),
      }), 200);
    }

    // If demo mode, use mock data
    let data;
    if (demo) {
      data = mockResult();
    } else {
      try {
        data = await lookupByPhone(normalized, env);
      } catch (err) {
        return htmlResponse(renderPage({
          title: "Caller Pop",
          content: renderError(err, normalized, rawPhone),
        }), 502);
      }
    }

    const view = renderCallerCard(data, {
      searched: normalized || rawPhone,
      raw: rawPhone,
    });

    return htmlResponse(renderPage({ title: "Caller Pop", content: view }), 200, {
      "Cache-Control": "no-store",
    });
  }
};

// --- Helpers ---------------------------------------------------------------

function normalizePhone(input, defaultCountry = "+1") {
  if (!input) return "";
  // Keep digits only
  const digits = String(input).replace(/[^\d]/g, "");
  if (!digits) return "";

  // If it's already 11+ with a leading "1" (US), convert to +1...
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  // If it's 10 digits, apply default country
  if (digits.length === 10) {
    const cc = defaultCountry.startsWith("+") ? defaultCountry : `+${defaultCountry.replace(/[^\d]/g, "")}`;
    const nd = digits;
    return `${cc}${nd}`;
  }

  // If it already looks like an E.164 without plus, add plus
  if (/^\d{11,15}$/.test(digits)) {
    return `+${digits}`;
  }

  // Otherwise, bail; you can relax this rule for international scenarios
  return `+${digits}`; // still return best-effort E.164-ish
}

async function lookupByPhone(e164, env) {
  if (!e164) throw new Error("No valid phone provided.");

  // Build request to your API
  const base = env.API_BASE_URL || "https://api.example.com/lookup";
  const apiUrl = new URL(base);
  apiUrl.searchParams.set("phone", e164);

  const resp = await fetch(apiUrl, {
    headers: {
      "Authorization": `Bearer ${env.API_TOKEN}`,
      "Accept": "application/json",
    }
  });

  if (!resp.ok) {
    const text = await safeText(resp);
    throw new Error(`Upstream API ${resp.status} ${resp.statusText}: ${text?.slice(0, 300)}`);
  }

  const json = await resp.json().catch(() => ({}));

  // Shape the result into a canonical format the UI expects
  return coerceToCallerSchema(json, e164);
}

async function safeText(resp) {
  try { return await resp.text(); } catch { return ""; }
}

/**
 * Coerces arbitrary API payloads into a stable schema the UI expects.
 * Adjust this mapping to your API’s response shape.
 */
function coerceToCallerSchema(api, phoneE164) {
  // Example flexible mapping:
  const primary = api?.primary || api?.data || api || {};

  return {
    phone: primary.phone || phoneE164,
    name: primary.name || primary.full_name || joinName(primary.first_name, primary.last_name) || "Unknown",
    company: primary.company || primary.org || "",
    title: primary.title || "",
    emails: arrayish(primary.emails || primary.email).filter(Boolean),
    altPhones: arrayish(primary.altPhones || primary.phones).filter(p => p && p !== phoneE164),
    address: formatAddress(primary.address || primary.location),
    tags: arrayish(primary.tags),
    risk: primary.risk || null,             // number 1..5 or null
    status: primary.status || "",           // e.g. "VIP", "Do Not Call"
    customerSince: primary.customer_since || primary.created_at || "",
    notes: arrayish(primary.notes),
    meta: primary.meta || {},               // any extra props you want to render
  };
}

function joinName(a, b) {
  return [a, b].filter(Boolean).join(" ").trim();
}
function arrayish(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}
function formatAddress(addr) {
  if (!addr) return "";
  if (typeof addr === "string") return addr;
  const parts = [
    addr.line1 || addr.street || "",
    addr.line2 || "",
    [addr.city, addr.state].filter(Boolean).join(", "),
    addr.postal || addr.zip || "",
    addr.country || ""
  ].filter(Boolean);
  return parts.join(" • ");
}

// --- Views ----------------------------------------------------------------

function renderForm(prefill = "") {
  return /*html*/`
  <form class="card p-4 gap-3" method="GET">
    <div>
      <label class="label">Phone number</label>
      <input class="input" type="text" name="phone" placeholder="+17145551212 or 714-555-1212" value="${escapeHtml(prefill)}" />
    </div>
    <div class="row gap-2">
      <button class="btn" type="submit">Search</button>
      <a class="btn btn-ghost" href="?demo=1">Demo</a>
    </div>
  </form>
  `;
}

function renderCallerCard(d, ctx) {
  return /*html*/`
  <section class="stack gap-4">
    <header class="row items-center justify-between">
      <h1 class="h1">Caller Info</h1>
      <span class="muted">Searched: ${escapeHtml(ctx.searched || "")}</span>
    </header>

    <div class="grid">
      <div class="card p-4 stack gap-3">
        <div class="row items-center justify-between">
          <div class="stack">
            <div class="title">${escapeHtml(d.name || "Unknown")}</div>
            <div class="muted">${escapeHtml(d.title || d.company || "")}</div>
          </div>
          ${badgeGroup(d)}
        </div>

        <div class="kv">
          ${kv("Primary Phone", linkPhone(d.phone))}
          ${kv("Other Phones", d.altPhones?.length ? d.altPhones.map(linkPhone).join("<span class='sep'>,</span> ") : "—")}
          ${kv("Email", d.emails?.length ? d.emails.map(linkEmail).join("<span class='sep'>,</span> ") : "—")}
          ${kv("Address", d.address || "—")}
          ${kv("Customer Since", d.customerSince || "—")}
        </div>

        ${d.notes?.length ? `<div class="notes"><div class="label">Notes</div><ul>${d.notes.map(n => `<li>${escapeHtml(n)}</li>`).join("")}</ul></div>` : ""}

        ${Object.keys(d.meta || {}).length ? renderMeta(d.meta) : ""}
      </div>

      <div class="card p-4">
        <div class="label">Actions</div>
        <div class="row wrap gap-2">
          ${d.phone ? `<a class="btn" href="tel:${encodeURIComponent(d.phone)}">Call</a>` : ""}
          ${d.emails?.[0] ? `<a class="btn" href="mailto:${encodeURIComponent(d.emails[0])}?subject=Follow%20up">Email</a>` : ""}
          <a class="btn btn-ghost" href="?phone=${encodeURIComponent(ctx.raw || d.phone || "")}">Refresh</a>
          <a class="btn btn-ghost" href="?">New Search</a>
        </div>
      </div>
    </div>
  </section>
  `;
}

function badgeGroup(d) {
  const tags = (d.tags || []).slice(0, 5).map(t => `<span class="badge">${escapeHtml(t)}</span>`).join("");
  const risk = d.risk ? `<span class="badge ${riskClass(d.risk)}">Risk: ${Number(d.risk)}</span>` : "";
  const status = d.status ? `<span class="badge">${escapeHtml(d.status)}</span>` : "";
  return `<div class="row gap-2 wrap">${risk}${status}${tags}</div>`;
}

function riskClass(r) {
  if (r >= 4) return "badge-danger";
  if (r === 3) return "badge-warn";
  return "badge-ok";
}

function kv(k, v) {
  return `<div class="kv-row"><div class="kv-k">${escapeHtml(k)}</div><div class="kv-v">${v}</div></div>`;
}

function linkPhone(p) {
  if (!p) return "—";
  return `<a class="link" href="tel:${encodeURIComponent(p)}">${escapeHtml(prettyPhone(p))}</a>`;
}

function linkEmail(e) {
  return `<a class="link" href="mailto:${encodeURIComponent(e)}">${escapeHtml(e)}</a>`;
}

function prettyPhone(e164) {
  // super light prettifier for +1 only; expand as needed
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (m) return `(${m[1]}) ${m[2]}-${m[3]}`;
  return e164;
}

function renderMeta(meta) {
  const rows = Object.entries(meta).map(([k, v]) => kv(k, escapeHtml(typeof v === "string" ? v : JSON.stringify(v))));
  return `<div class="label mt">Extra</div><div class="kv">${rows.join("")}</div>`;
}

function renderError(err, normalized, raw) {
  return /*html*/`
    <div class="card p-4 stack gap-3">
      <div class="title">Lookup failed</div>
      <div class="muted">Tried: ${escapeHtml(normalized || raw || "")}</div>
      <pre class="code">${escapeHtml(String(err?.message || err))}</pre>
      ${renderForm(raw)}
    </div>
  `;
}

function renderPage({ title, content }) {
  return /*html*/`<!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Cache-Control" content="no-store" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        --bg: #0f172a;        /* slate-900 */
        --card: #111827;      /* gray-900 */
        --muted: #94a3b8;     /* slate-400 */
        --text: #e5e7eb;      /* gray-200 */
        --accent: #60a5fa;    /* blue-400 */
        --good: #22c55e;      /* green-500 */
        --warn: #f59e0b;      /* amber-500 */
        --danger: #ef4444;    /* red-500 */
        --border: #1f2937;    /* gray-800 */
      }
      html,body { margin:0; padding:0; background:var(--bg); color:var(--text); font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto; }
      .container { max-width: 1100px; margin: 24px auto; padding: 0 16px; }
      .h1 { font-size: 24px; font-weight: 700; letter-spacing: .2px; }
      .title { font-size: 18px; font-weight: 600; }
      .muted { color: var(--muted); }
      .stack { display: flex; flex-direction: column; }
      .row { display: flex; align-items: center; }
      .wrap { flex-wrap: wrap; }
      .gap-2 { gap: 8px; }
      .gap-3 { gap: 12px; }
      .gap-4 { gap: 16px; }
      .items-center { align-items: center; }
      .justify-between { justify-content: space-between; }
      .mt { margin-top: 8px; }

      .grid { display: grid; grid-template-columns: 1.3fr .7fr; gap: 16px; }
      @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }

      .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; }
      .p-4 { padding: 16px; }

      .label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; }
      .input { width: 100%; background:#0b1220; color: var(--text); border:1px solid var(--border); border-radius:10px; padding:10px 12px; }
      .btn { appearance:none; border:1px solid var(--border); background: #0b1220; color: var(--text); padding:10px 14px; border-radius: 10px; text-decoration:none; display:inline-block; }
      .btn:hover { border-color: var(--accent); }
      .btn-ghost { background: transparent; }
      .link { color: var(--accent); text-decoration: none; }
      .link:hover { text-decoration: underline; }

      .badge { display:inline-block; padding:4px 8px; border-radius:999px; font-size:12px; background:#0b1220; border:1px solid var(--border); }
      .badge-ok { border-color: var(--good); color: var(--good); }
      .badge-warn { border-color: var(--warn); color: var(--warn); }
      .badge-danger { border-color: var(--danger); color: var(--danger); }

      .kv { display:flex; flex-direction:column; gap:8px; }
      .kv-row { display:grid; grid-template-columns: 160px 1fr; gap: 8px; }
      .kv-k { color: var(--muted); }
      .kv-v { word-break: break-word; }
      .sep { margin: 0 6px; color: var(--muted); }

      .notes ul { margin: 6px 0 0 18px; }

      .code { white-space: pre-wrap; background:#0b1220; border:1px solid var(--border); padding:10px; border-radius:10px; color: var(--muted); }
    </style>
  </head>
  <body>
    <div class="container">
      ${content}
    </div>
  </body>
  </html>`;
}

function htmlResponse(html, status = 200, extraHeaders = {}) {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-robots-tag": "noindex",
      ...extraHeaders,
    }
  });
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
}

// --- Demo data -------------------------------------------------------------

function mockResult() {
  return {
    phone: "+17146555375",
    name: "Jordan Park",
    company: "Acme Retail, Inc.",
    title: "Facilities Manager",
    emails: ["jordan.park@example.com"],
    altPhones: ["+17145551212"],
    address: "123 Harbor Blvd • Long Beach, CA 90802 • USA",
    tags: ["VIP", "Facilities", "West Region"],
    risk: 2,
    status: "Active",
    customerSince: "2021-06-15",
    notes: [
      "Prefers SMS for confirmations.",
      "Opened ticket #48291 (HVAC) last month."
    ],
    meta: {
      "Account ID": "CUST-23994",
      "Last Order": "2025-08-31",
      "NPS": 9
    }
  };
}
