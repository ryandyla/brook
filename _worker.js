export default {
  async fetch(request, env, ctx) {
    // 1) Try to serve static files (like /brook.png)
    const assetResp = await env.ASSETS.fetch(request);
    if (assetResp.status !== 404) {
      return assetResp;
    }

    // 2) If no static file matched, continue with your Worker logic
    const url = new URL(request.url);
    const q = url.searchParams;
    const demo = q.get("demo") === "1";
    const rawPhone = (q.get("phone") || "").trim();

    // ... rest of your caller lookup code
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const q = url.searchParams;
    const demo = q.get("demo") === "1";
    const rawPhone = (q.get("phone") || "").trim();
    const normalized = normalizePhone(rawPhone, env.DEFAULT_COUNTRY || "+1");

    if (!normalized && !demo) {
      return html(renderPage({ title: "Caller Pop", content: renderForm(rawPhone) }));
    }

    try {
      const data = demo ? mockResult() : await lookupByPhone(normalized, env);
      const view = renderCallerLayout(data, { searched: normalized || rawPhone, raw: rawPhone });
      return html(renderPage({ title: "Caller Pop", content: view }), 200, { "Cache-Control": "no-store" });
    } catch (err) {
      return html(
        renderPage({ title: "Caller Pop", content: renderError(err, normalized, rawPhone) }),
        502
      );
    }
  }
};

/* ---------------- API CALL & SCHEMA ---------------- */
async function lookupByPhone(e164, env) {
  if (!env.API_URL) throw new Error("Missing API_URL");
  if (!env.VERIFY_TOKEN) throw new Error("Missing VERIFY_TOKEN");
  if (!e164) throw new Error("No valid phone provided");

  const digitsOnly = e164.replace(/[^\d]/g, "");
  const body = JSON.stringify({ phone_number: digitsOnly });

  const resp = await fetch(env.API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "verification-token": env.VERIFY_TOKEN,
      "accept": "application/json"
    },
    body
  });

  if (!resp.ok) {
    const text = await safeText(resp);
    throw new Error(`Upstream ${resp.status} ${resp.statusText}: ${text?.slice(0, 300)}`);
  }

  const api = await resp.json();
  return coerceToCallerSchema(api, e164);
}

async function safeText(resp) { try { return await resp.text(); } catch { return ""; } }

/* Coerce your payload to a stable UI schema */
function coerceToCallerSchema(p, phoneE164) {
  p = p || {};
  const name = [p.first_name, p.last_name].filter(Boolean).join(" ").trim() || "Unknown";
  const pri = p.insurance?.primary || "";
  const sec = p.insurance?.secondary || "";

  return {
    // Contact block
    phone: phoneE164,
    name,
    papId: p.pap_id ?? null,
    emails: p.email_address ? [p.email_address] : [],
    address: p.home_address || "",
    dob: p.date_of_birth || "",

    // Coverage block
    copay: (p.copay_amount != null) ? Number(p.copay_amount) : null,
    insurancePrimary: pri,
    insuranceSecondary: sec,
    eligibility: Array.isArray(p.program_eligibility) ? p.program_eligibility : [],

    // Care team block
    clinic: p.clinic_name || "",
    provider: p.provider_name || "",

    // Extras if you ever want them
    altPhones: [],
    meta: {}
  };
}

/* ---------------- UI ---------------- */
function renderForm(prefill = "") {
  return /*html*/`
    <form class="card p-4 gap-3" method="GET">
      <div>
        <label class="label">Phone number</label>
        <input class="input" type="text" name="phone" placeholder="+17145551212 or 714-555-1212" value="${esc(prefill)}" />
      </div>
      <div class="row gap-2">
        <button class="btn" type="submit">Search</button>
        <a class="btn btn-ghost" href="?demo=1">Demo</a>
      </div>
    </form>`;
}

function renderCallerLayout(d, ctx) {
  return /*html*/`
  <section class="stack gap-4">
  <header class="row items-center justify-between header">
    <div class="row items-center gap-2">
      <img src="brook.png" alt="Brook Health" class="logo" />
      <h1 class="h1">Caller Info</h1>
    </div>
    <span class="muted">Searched: ${esc(ctx.searched || "")}</span>
  </header>


    <div class="grid">
      <div class="stack gap-4">
        ${contactBlock(d)}
        ${coverageBlock(d)}
        ${careTeamBlock(d)}
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
  </section>`;
}

/* ---- Blocks ---- */
function contactBlock(d) {
  return /*html*/`
  <div class="card p-4 stack gap-3">
    <div class="row items-center justify-between">
      <div class="stack">
        <div class="title">${esc(d.name || "Unknown")}</div>
        ${d.papId != null ? `<div class="subtle">PAP ID: ${esc(String(d.papId))}</div>` : ""}
      </div>
    </div>

    <div class="kv">
      ${kv("Primary Phone", linkPhone(d.phone))}
      ${kv("Email", d.emails?.length ? d.emails.map(linkEmail).join("<span class='sep'>,</span> ") : "—")}
      ${kv("Address", d.address || "—")}
      ${kv("D.O.B.", d.dob || "—")}
    </div>
  </div>`;
}

function coverageBlock(d) {
  const badges = (d.eligibility || []).map(t => `<span class="eligibility-badge">${esc(t)}</span>`).join("");
  return /*html*/`
  <div class="card p-4 stack gap-3">
    <div class="title">Coverage</div>
    <div class="kv">
      ${kv("Copay", d.copay != null ? `$${d.copay.toFixed(2)}` : "—")}
      ${kv("Insurance (Primary)", d.insurancePrimary || "—")}
      ${kv("Insurance (Secondary)", d.insuranceSecondary || "—")}
    </div>
    ${
      d.eligibility?.length
        ? `<div class="eligibility">
             <div class="label">Program Eligibility</div>
             <div class="eligibility-tags">${badges}</div>
           </div>`
        : ""
    }
  </div>`;
}

function careTeamBlock(d) {
  return /*html*/`
  <div class="card p-4 stack gap-3">
    <div class="title">Care Team</div>
    <div class="kv">
      ${kv("Clinic", d.clinic || "—")}
      ${kv("Provider", d.provider || "—")}
    </div>
  </div>`;
}

/* ---- small view helpers ---- */
function kv(k, v) { return `<div class="kv-row"><div class="kv-k">${esc(k)}</div><div class="kv-v">${v}</div></div>`; }
function linkPhone(p) { return p ? `<a class="link" href="tel:${encodeURIComponent(p)}">${esc(prettyUS(p))}</a>` : "—"; }
function linkEmail(e) { return `<a class="link" href="mailto:${encodeURIComponent(e)}">${esc(e)}</a>`; }
function prettyUS(e164) { const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164; }

/* ---- error view ---- */
function renderError(err, normalized, raw) {
  return /*html*/`
    <div class="card p-4 stack gap-3">
      <div class="title">Lookup failed</div>
      <div class="muted">Tried: ${esc(normalized || raw || "")}</div>
      <pre class="code">${esc(String(err?.message || err))}</pre>
      ${renderForm(raw)}
    </div>`;
}

/* ---------------- STYLES & SHELL ---------------- */
function renderPage({ title, content }) {
  return /*html*/`<!doctype html>
  <html lang="en"><head>
    <meta charset="utf-8" />
    <meta http-equiv="Cache-Control" content="no-store" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)}</title>
    <style>
      :root { --bg:#0f172a; --card:#111827; --muted:#94a3b8; --text:#e5e7eb; --accent:#60a5fa; --border:#1f2937; --chip:#0b1220; }
      html,body { margin:0; padding:0; background:var(--bg); color:var(--text); font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto; }
      .container { max-width: 1100px; margin: 24px auto; padding: 0 16px; }
      .h1 { font-size: 24px; font-weight: 700; letter-spacing: .2px; }
      .title { font-size: 18px; font-weight: 600; }
      .subtle { color: var(--muted); font-size: 13px; margin-top: 2px; }
      .muted { color: var(--muted); }
      .stack { display:flex; flex-direction:column; }
      .row { display:flex; align-items:center; }
      .wrap { flex-wrap:wrap; }
      .gap-2 { gap:8px; } .gap-3{gap:12px;} .gap-4{gap:16px;}
      .items-center { align-items:center; } .justify-between{justify-content:space-between;}
      .grid { display:grid; grid-template-columns: 1.3fr .7fr; gap:16px; } @media (max-width:900px){ .grid{ grid-template-columns:1fr; } }
      .card { background:var(--card); border:1px solid var(--border); border-radius:14px; }
      .p-4 { padding:16px; }
      .label { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.08em; }
      .input { width:100%; background:#0b1220; color:var(--text); border:1px solid var(--border); border-radius:10px; padding:10px 12px; }
      .btn { appearance:none; border:1px solid var(--border); background:#0b1220; color:var(--text); padding:10px 14px; border-radius:10px; text-decoration:none; display:inline-block; }
      .btn:hover { border-color: var(--accent); }
      .btn-ghost { background:transparent; }
      .link { color:var(--accent); text-decoration:none; } .link:hover { text-decoration:underline; }
      .kv { display:flex; flex-direction:column; gap:8px; }
      .kv-row { display:grid; grid-template-columns: 180px 1fr; gap:8px; } @media (max-width:600px){ .kv-row { grid-template-columns:120px 1fr; } }
      .kv-k { color: var(--muted); } .kv-v { word-break:break-word; } .sep { margin:0 6px; color:var(--muted); }
      .code { white-space:pre-wrap; background:#0b1220; border:1px solid var(--border); padding:10px; border-radius:10px; color:var(--muted); }
      .eligibility { border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: var(--chip); }
      .eligibility-tags { display:flex; flex-wrap:wrap; gap:8px; margin-top:6px; }
      .eligibility-badge { background: var(--accent); color:#fff; padding:4px 10px; border-radius:999px; font-size:13px; font-weight:500; }
      .header { border-bottom: 1px solid var(--border); padding-bottom: 8px; margin-bottom: 12px; }
      .logo { height: 32px; }
    </style>
  </head><body><div class="container">${content}</div></body></html>`;
}

function html(html, status = 200, extra = {}) {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", ...extra } });
}

function esc(s) { return String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;"); }

/* ---------------- UTIL ---------------- */
function normalizePhone(input, defaultCountry = "+1") {
  if (!input) return "";
  const digits = String(input).replace(/[^\d]/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) {
    const cc = defaultCountry.startsWith("+") ? defaultCountry : `+${defaultCountry.replace(/[^\d]/g, "")}`;
    return `${cc}${digits}`;
  }
  if (/^\d{11,15}$/.test(digits)) return `+${digits}`;
  return `+${digits}`;
}

/* ---------------- DEMO ---------------- */
function mockResult() {
  return {
    phone: "+17146555375",
    name: "Ryan Dyla 2",
    papId: 302,
    emails: ["jorge+oncm61@brook.ai"],
    address: "123 La Cuarta Unit 12A, Morgan Hill, CA 92228",
    dob: "1980-08-01",
    copay: 10.0,
    insurancePrimary: "Primary Insurance",
    insuranceSecondary: "",
    eligibility: ["CHF","Obesity","Diabetes","Hypertension"],
    clinic: "One New Clinic Medical - MassAdvantage SCHEMA",
    provider: "Dr. Jhay Booh PSDHF",
    altPhones: [],
    meta: {}
  };
}
