// Cloudflare Worker for logiztek.com
//  1. Serves the static site
//  2. POST /api/contact — the "Get in touch" box on the home page
//  3. POST /api/submit  — the onboarding and project forms
//  4. Customer records — opted-in submitters are saved to the
//     "Logiztek customers" audience in Resend (never fails the form)
//
// Secrets needed: RESEND_API_KEY, RESEND_AUDIENCE_ID (both already set)
//
// FRONTEND NOTE: a submitter is recorded ONLY when the form sends
// `updates: true` (an "Email me helpful updates" checkbox). Optional fields
// the forms can also send: `whatsapp_updates: true`, `sms_updates: true`,
// `formKind: "project" | "start"`, and `name` / `company` / `phone` on
// /api/submit so records are complete. Without `updates`, nothing is recorded.

const FROM = 'Logiztek <notifications@mail.logiztek.com>';
const OWNER = 'info@logiztek.com';
const RESEND_API = 'https://api.resend.com';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST') {
      if (url.pathname === '/api/contact') return handleContact(request, env, ctx);
      if (url.pathname === '/api/submit') return handleSubmit(request, env, ctx);
    }

    // Everything else: serve the static site as-is
    return env.ASSETS.fetch(request);
  }
};

/* ---------- Contact box ---------- */

async function handleContact(request, env, ctx) {
  // Only accept requests that come from our own pages
  if (!sameOrigin(request)) return json({ error: 'Forbidden' }, 403);

  // Slow down anyone sending many at once
  if (await isRateLimited(env, request, 'contact')) {
    return json({ error: 'Too many requests' }, 429);
  }

  let d;
  try {
    d = await request.json();
  } catch (e) {
    return json({ error: 'Invalid request body' }, 400);
  }

  // Trap field: real people never see it, simple bots fill it in.
  // Answer "success" so the bot learns nothing, and send nothing.
  if (d.website) return json({ ok: true }, 200);

  // Nobody fills a form in under 3 seconds
  if (typeof d.elapsedMs !== 'number' || d.elapsedMs < 3000) {
    return json({ error: 'Please take a moment to fill in the form' }, 400);
  }

  const name = String(d.name || '').trim();
  const email = String(d.email || '').trim();
  const phone = String(d.phone || '').trim();
  const message = String(d.message || '').trim();

  if (!validName(name)) return json({ error: 'Please enter your name' }, 400);
  if (!isEmail(email)) return json({ error: 'Invalid email address' }, 400);
  if (phone && phone.replace(/\D/g, '').length < 10) return json({ error: 'Invalid phone number' }, 400);
  if (message.length < 10 || message.length > 2000) return json({ error: 'Message must be 10 to 2000 characters' }, 400);

  const cleanName = name.replace(/[\r\n]+/g, ' ').slice(0, 80);

  const text = [
    'NEW WEBSITE MESSAGE',
    '',
    'Name: ' + cleanName,
    'Email: ' + email,
    'Phone: ' + (phone || '—'),
    '',
    'MESSAGE',
    message
  ].join('\n');

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM,
        to: [OWNER],
        reply_to: email,
        subject: 'Website message — ' + cleanName,
        text: text
      })
    });
    if (!res.ok) return json({ error: 'Send failed' }, 502);

    // Save opted-in submitters to the customer list (runs in background,
    // never delays or fails the form response)
    if (isOptedIn(d.updates)) {
      ctx.waitUntil(recordCustomer(env, {
        email: email,
        firstName: firstNameOf(cleanName),
        lastName: lastNameOf(cleanName),
        company: '',
        phone: phone,
        serviceLine: '',
        source: 'contact_form',
        smsOptIn: isOptedIn(d.sms_updates),
        whatsappOptIn: isOptedIn(d.whatsapp_updates)
      }));
    }

    return json({ ok: true }, 200);
  } catch (e) {
    return json({ error: 'Unexpected error' }, 500);
  }
}

/* ---------- Onboarding and project forms ---------- */

async function handleSubmit(request, env, ctx) {
  if (!sameOrigin(request)) return json({ error: 'Forbidden' }, 403);

  if (await isRateLimited(env, request, 'submit')) {
    return json({ error: 'Too many requests' }, 429);
  }

  let data;
  try {
    data = await request.json();
  } catch (e) {
    return json({ error: 'Invalid request body' }, 400);
  }

  const { subject, contactEmail, text } = data;

  if (!subject || !contactEmail || !text) {
    return json({ error: 'Missing required fields' }, 400);
  }

  if (!isEmail(contactEmail)) {
    return json({ error: 'Invalid email address' }, 400);
  }

  try {
    const resendResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM,
        to: [OWNER],
        cc: [contactEmail],
        reply_to: contactEmail,
        subject: subject,
        text: text
      })
    });

    if (!resendResp.ok) {
      const errText = await resendResp.text();
      return json({ error: 'Send failed', detail: errText }, 502);
    }

    // Save opted-in submitters to the customer list (runs in background,
    // never delays or fails the form response)
    if (isOptedIn(data.updates)) {
      ctx.waitUntil(recordCustomer(env, {
        email: contactEmail,
        firstName: firstNameOf(data.name),
        lastName: lastNameOf(data.name),
        company: String(data.company || ''),
        phone: String(data.phone || ''),
        serviceLine: serviceLineFrom(data),
        source: data.formKind === 'project' ? 'project_form'
              : data.formKind === 'start'   ? 'start_form'
              : 'submit_form',
        smsOptIn: isOptedIn(data.sms_updates),
        whatsappOptIn: isOptedIn(data.whatsapp_updates)
      }));
    }

    return json({ ok: true }, 200);
  } catch (e) {
    return json({ error: 'Unexpected error', detail: e.message }, 500);
  }
}

/* ---------- Customer records (Resend audience) ---------- */

async function resendApi(env, path, options = {}) {
  return fetch(`${RESEND_API}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
}

// Upsert a contact by email: update if they already exist, create if new.
// Never throws — a CRM write must not fail the customer's form submission.
// NOTE: Resend contact properties are strings, so opt-ins are "true"/"false".
async function recordCustomer(env, { email, firstName, lastName, company, phone, serviceLine, source, smsOptIn, whatsappOptIn }) {
  try {
    const audienceId = env.RESEND_AUDIENCE_ID;
    if (!audienceId || !email) return;

    const base = `/audiences/${audienceId}/contacts`;
    const id = encodeURIComponent(String(email).trim().toLowerCase());
    const properties = {
      company: company || '',
      phone: phone || '',
      service_line: serviceLine || '',
      source: source || '',
      opted_in_at: new Date().toISOString(),
      sms_opt_in: smsOptIn ? 'true' : 'false',
      whatsapp_opt_in: whatsappOptIn ? 'true' : 'false'
    };

    const existing = await resendApi(env, `${base}/${id}`);
    const fields = {
      first_name: firstName || '',
      last_name: lastName || '',
      unsubscribed: false,
      properties
    };

    if (existing.ok) {
      await resendApi(env, `${base}/${id}`, { method: 'PATCH', body: JSON.stringify(fields) });
    } else {
      await resendApi(env, base, {
        method: 'POST',
        body: JSON.stringify({ email: String(email).trim().toLowerCase(), ...fields })
      });
    }
  } catch (err) {
    console.error('recordCustomer failed:', err);
  }
}

// Best-effort service line for /api/submit. Send `formKind: "project"`
// or `"start"` from the frontend for an exact value.
function serviceLineFrom(data) {
  if (data.formKind === 'project') return 'it';
  if (data.formKind === 'start') return 'bookkeeping';
  const s = String(data.subject || '');
  if (/project|cloud|devops/i.test(s)) return 'it';
  if (/onboard|bookkeep|payroll/i.test(s)) return 'bookkeeping';
  return '';
}

// Accepts true, "true", "on", 1 — however the frontend checkbox sends it
function isOptedIn(v) {
  return v === true || v === 'true' || v === 'on' || v === 1;
}

function firstNameOf(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

function lastNameOf(name) {
  return String(name || '').trim().split(/\s+/).slice(1).join(' ') || '';
}

/* ---------- Helpers ---------- */

// The request must come from a page on this same site
function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch (e) {
    return false;
  }
}

// Uses the FORM_LIMITER binding from wrangler.toml. If it isn't there, skip quietly.
async function isRateLimited(env, request, scope) {
  if (!env.FORM_LIMITER) return false;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  try {
    const { success } = await env.FORM_LIMITER.limit({ key: scope + ':' + ip });
    return !success;
  } catch (e) {
    return false;
  }
}

function validName(v) {
  return v.length >= 2 && /[A-Za-z]/.test(v) && !/^(.)\1+$/.test(v.replace(/\s/g, ''));
}

function isEmail(v) {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
