// Cloudflare Worker for logiztek.com
//  1. Serves the static site
//  2. POST /api/submit  — sends the onboarding / project forms by email
//  3. Weekly customer reminders — runs on the schedule in wrangler.toml,
//     and can also be triggered on demand with POST /api/notify
//
// Secrets (set in Cloudflare → Settings → Variables and secrets, type "Secret"):
//   RESEND_API_KEY  — already set
//   CLIENTS_JSON    — list of clients to remind (see below)
//   NOTIFY_TOKEN    — password for the on-demand trigger

const FROM = 'Logiztek <notifications@mail.logiztek.com>';
const OWNER = 'info@logiztek.com';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/submit' && request.method === 'POST') {
      return handleSubmit(request, env);
    }
    if (url.pathname === '/api/notify' && request.method === 'POST') {
      return handleNotifyNow(request, env);
    }

    // Everything else: serve the static site as-is
    return env.ASSETS.fetch(request);
  },

  // Runs automatically on the cron schedule in wrangler.toml
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendReminders(env));
  }
};

/* ---------- Forms (unchanged) ---------- */

async function handleSubmit(request, env) {
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

function isEmail(v) {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
