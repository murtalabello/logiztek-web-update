// Cloudflare Worker for logiztek.com
//  1. Serves the static site
//  2. POST /api/contact — the "Get in touch" box on the home page
//  3. POST /api/submit  — the onboarding and project forms
//  4. Weekly customer reminders — runs on the schedule in wrangler.toml,
//     and can also be triggered on demand with POST /api/notify
//
// Secrets (Cloudflare → Settings → Variables and secrets → type "Secret"):
//   RESEND_API_KEY    — already set
//   CLIENTS_JSON      — clients to remind (format shown above sendReminders)
//   NOTIFY_TOKEN      — password for the on-demand trigger
//   TURNSTILE_SECRET  — optional; turns on Cloudflare's free bot check

const FROM = 'Logiztek <notifications@mail.logiztek.com>';
const OWNER = 'info@logiztek.com';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST') {
      if (url.pathname === '/api/contact') return handleContact(request, env);
      if (url.pathname === '/api/submit') return handleSubmit(request, env);
      if (url.pathname === '/api/notify') return handleNotifyNow(request, env);
    }

    // Everything else: serve the static site as-is
    return env.ASSETS.fetch(request);
  },

  // Runs automatically on the cron schedule in wrangler.toml
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendReminders(env));
  }
};

/* ---------- Contact box ---------- */

async function handleContact(request, env) {
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

  // Cloudflare Turnstile check (only when TURNSTILE_SECRET is set)
  if (env.TURNSTILE_SECRET) {
    const passed = await verifyTurnstile(d.turnstileToken, env.TURNSTILE_SECRET, request);
    if (!passed) return json({ error: 'Verification failed' }, 400);
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
    return json({ ok: true }, 200);
  } catch (e) {
    return json({ error: 'Unexpected error' }, 500);
  }
}

async function verifyTurnstile(token, secret, request) {
  if (!token) return false;
  try {
    const form = new URLSearchParams();
    form.append('secret', secret);
    form.append('response', String(token));
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip) form.append('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form
    });
    const out = await res.json();
    return out.success === true;
  } catch (e) {
    return false;
  }
}

/* ---------- Onboarding and project forms ---------- */

async function handleSubmit(request, env) {
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

    return json({ ok: true }, 200);
  } catch (e) {
    return json({ error: 'Unexpected error', detail: e.message }, 500);
  }
}

/* ---------- Weekly customer reminders ---------- */

// On-demand trigger: POST /api/notify with header  x-admin-token: <NOTIFY_TOKEN>
async function handleNotifyNow(request, env) {
  const token = request.headers.get('x-admin-token');
  if (!env.NOTIFY_TOKEN || !token || token !== env.NOTIFY_TOKEN) {
    return json({ error: 'Not authorized' }, 401);
  }
  const result = await sendReminders(env);
  return json(result, result.ok ? 200 : 500);
}

/*
  CLIENTS_JSON looks like this (one entry per client):
  [
    {"name":"ABC Company LLC","contact":"Jane","email":"jane@abc.com","uploadLink":"https://www.dropbox.com/request/XXXX"},
    {"name":"XYZ Home Care","email":"owner@xyz.com","active":false}
  ]
  - contact and uploadLink are optional
  - "active": false pauses a client without deleting them
*/
async function sendReminders(env) {
  let clients;
  try {
    clients = JSON.parse(env.CLIENTS_JSON || '[]');
  } catch (e) {
    return { ok: false, error: 'CLIENTS_JSON is not valid JSON' };
  }
  if (!Array.isArray(clients)) {
    return { ok: false, error: 'CLIENTS_JSON must be a list' };
  }

  const active = clients.filter(c => c && c.active !== false && isEmail(c.email));
  if (active.length === 0) {
    return { ok: true, sent: 0, note: 'No active clients configured' };
  }

  const messages = active.map(c => ({
    from: FROM,
    to: [c.email],
    reply_to: OWNER,
    subject: 'Weekly reminder: send your latest documents',
    text: buildReminder(c)
  }));

  let sent = 0;
  let failed = 0;

  // Resend's batch endpoint takes up to 100 emails per request
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      const res = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(chunk)
      });
      if (res.ok) { sent += chunk.length; } else { failed += chunk.length; }
    } catch (e) {
      failed += chunk.length;
    }
  }

  // One summary email to you so you always know what happened
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM,
        to: [OWNER],
        subject: `Weekly reminders: ${sent} sent, ${failed} failed`,
        text: `Weekly client reminders finished.\n\nSent: ${sent}\nFailed: ${failed}\n`
      })
    });
  } catch (e) {
    // The summary is a courtesy — never let it break the run
  }

  return { ok: failed === 0, sent, failed };
}

function buildReminder(c) {
  const greeting = c.contact
    ? `Hi ${c.contact},`
    : (c.name ? `Hello ${c.name} team,` : 'Hello,');
  const action = c.uploadLink
    ? `Upload here: ${c.uploadLink}`
    : 'Just reply to this email with your documents attached.';

  return [
    greeting,
    '',
    'Quick weekly reminder from Logiztek: please send over any new invoices, receipts, and bank or card statements from this past week so your books stay current.',
    '',
    action,
    '',
    'If nothing has changed this week, no action is needed. Questions? Just reply to this email.',
    '',
    'Thank you,',
    'Logiztek',
    'info@logiztek.com · (469) 726-9610'
  ].join('\n');
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
