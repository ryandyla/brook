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
      const view = renderCallerCard(data, { searched: normalized || rawPhone, raw: rawPhone });
      return html(renderPage({ title: "Caller Pop", content: view }), 200, { "Cache-Control": "no-store" });
    } catch (err) {
      return html(
        renderPage({
          title: "Caller Pop",
          content: renderError(err, normalized, rawPhone),
        }),
        502
      );
    }
  }
};

/** ------------ API CALL & MAPPING ------------ */
async function lookupByPhone(e164, env) {
  if (!env.API_URL) throw new Error("Missing API_URL");
  if (!env.VERIFY_TOKEN) throw new Error("Missing VERIFY_TOKEN");
  if (!e164) throw new Error("No valid phone provided");

  // Strip + for the payload, since your API wants digits only
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

/** Coerce your sample payload to a stable UI schema */
function coerceToCallerSchema(api, phoneE164) {
  // sample you provided:
  // {"pap_id":302,"first_name":"Ryan","last_name":"Dyla 2","provider_name":"Dr. ...",
  //  "clinic_name":"One New Clinic ...","program_eligibility":["CHF","Obesity","Diabetes","Hypertension"],
  //  "date_of_birth":"1980-08-01","email_address":"...","home_address":"...", "copay_amount":10.0,
  //  "insurance":{"primary":"Primary Insurance"}}

  const p = api || {};
  const name = [p.first_name, p.last_name].filter(Boolean).join(" ").trim() || "Unknown";

  return {
    phone: phoneE164,
    name,
    title: p.provider_name || "",
    company: p.clinic_name || "",
    emails: p.email_address ? [p.email_address] : [],
    altPhones: [], // none in sample
    address: p.home_address || "",
    tags: Array.isArray(p.program_eligibility) ? p.program_eligibility : [],
    risk: null,                         // not provided
    status: "",                         // not provided
    customerSince: "",                  // not provided
    notes: [
      p.pap_id ? `PAP ID: ${p.pap_id}` : null,
      p.copay_amount != null ? `Copay: $${Number(p.copay_amount).toFixed(2)}` : null,
      p.insurance?.primary ? `Primary Insurance: ${p.insurance.primary}` : null,
      p.date_of_birth ? `DOB: ${p.date_of_birth}` : null
    ].filter(Boolean),
    meta: {
      ...(p.provider_name ? { "Provider": p.provider_name } : {}),
      ...(p.clinic_name ? { "Clinic": p.clinic_name } : {})
    }
  };
}

/** ------------ UI RENDERING ------------ */
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

function renderCallerCard(d, ctx) {
  return /*html*/`
  <section class="stack gap-4">
    <header class="row items-center justify-between">
      <h1 class="h1">Caller Info</h1>
      <span class="muted">Searched: ${esc(ctx.searched || "")}</span>
    </header>

    <div class="grid">
      <div class="card p-4 stack gap-3">
        <div class="row items-center justify-between">
          <div class="stack">
            <div class="title">${esc(d.name || "Unknown")}</div>
            <div class="muted">${esc(d.title || d.company || "")}</div>
          </div>
          ${badgeGroup(d)}
        </div>

        <div class="kv">
          ${kv("Primary Phone", linkPhone(d.phone))}
          ${kv("Other Phones", d.altPhones?.length ? d.altPhones.map(linkPhone).join("<span class='sep'>,</span> ") : "—")}
          ${kv("Email", d.emails?.length ? d.emails.map(linkEmail).join("<span class='sep'>,</span> ") : "—")}
          ${kv("Address", d.address || "—")}
          ${kv("Clinic", d.meta?.Clinic || "—")}
          ${kv("Provider", d.meta?.Provider || "—")}
        </div>

        ${d.notes?.length ? `<div class="notes"><div class="label">Notes</div><ul>${d.notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul></div>` : ""}
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

function badgeGroup(d) {
  const tags = (d.tags || []).slice(0, 5).map(t => `<span class="badge">${esc(t)}</span>`).join("");
  return `<div class="row gap-2 wrap">${tags}</div>`;
}
function kv(k, v) { return `<div class="kv-row"><div class="kv-k">${esc(k)}</div><div class="kv-v">${v}</div></div>`; }
function linkPhone(p) { return p ? `<a class="link" href="tel:${encodeURIComponent(p)}">${esc(prettyUS(p))}</a>` : "—"; }
function linkEmail(e) { return `<a class="link" href="mailto:${encodeURIComponent(e)}">${esc(e)}</a>`; }
function prettyUS(e164) { const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164; }

function renderError(err, normalized, raw) {
  return /*html*/`
    <div class="card p-4 stack gap-3">
      <div class="title">Lookup failed</div>
      <div class="muted">Tried: ${esc(normalized || raw || "")}</div>
      <pre class="code">${esc(String(err?.message || err))}</pre>
      ${renderForm(raw)}
    </div>`;
}

/** ------------ UTILS & STYLES ------------ */
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

function esc(s) {
  return String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
}

function renderPage({ title, content }) {
  return /*html*/`<!doctype html>
  <html lang="en"><head>
    <meta charset="utf-8" />
    <meta http-equiv="Cache-Control" content="no-store" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)}</title>
    <style>
      :root { --bg:#0f172a; --card:#111827; --muted:#94a3b8; --text:#e5e7eb; --accent:#60a5fa; --border:#1f2937; }
      html,body { margin:0; padding:0; background:var(--bg); color:var(--text); font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto; }
      .container { max-width: 1100px; margin: 24px auto; padding: 0 16px; }
      .h1 { font-size: 24px; font-weight: 700; letter-spacing: .2px; }
      .title { font-size: 18px; font-weight: 600; }
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
      .badge { display:inline-block; padding:4px 8px; border-radius:999px; font-size:12px; background:#0b1220; border:1px solid var(--border); }
      .kv { display:flex; flex-direction:column; gap:8px; }
      .kv-row { display:grid; grid-template-columns: 160px 1fr; gap:8px; } @media (max-width:600px){ .kv-row { grid-template-columns:120px 1fr; } }
      .kv-k { color:var(--muted); } .kv-v { word-break:break-word; } .sep { margin:0 6px; color:var(--muted); }
      .notes ul { margin:6px 0 0 18px; }
      .code { white-space:pre-wrap; background:#0b1220; border:1px solid var(--border); padding:10px; border-radius:10px; color:var(--muted); }
    </style>
  </head><body><div class="container">${content}</div></body></html>`;
}

function html(html, status = 200, extra = {}) {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", ...extra } });
}

/** ------------ DEMO ------------ */
function mockResult() {
  return {
    phone: "+17146555375",
    name: "Ryan Dyla Test",
    title: "Dr. Jhay Booh PSDHF",
    company: "One New Clinic Medical - MassAdvantage SCHEMA",
    emails: ["jorge+oncm61@brook.ai"],
    altPhones: [],
    address: "123 La Cuarta Unit 12A, Morgan Hill, CA 92228",
    tags: ["CHF","Obesity","Diabetes","Hypertension"],
    risk: null,
    status: "",
    customerSince: "",
    notes: ["PAP ID: 302", "Copay: $10.00", "Primary Insurance: Primary Insurance", "DOB: 1980-08-01"],
    meta: { Clinic: "One New Clinic Medical - MassAdvantage SCHEMA", Provider: "Dr. Jhay Booh PSDHF" }
  };
}
