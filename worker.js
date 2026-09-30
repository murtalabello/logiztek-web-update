// Cloudflare Worker for logiztek.com
//  1. Serves the static site
//  2. POST /api/contact — the "Get in touch" box on the home page
//  3. POST /api/submit  — the onboarding and project forms
//
// Secret needed: RESEND_API_KEY (already set)

const FROM = 'Logiztek <notifications@mail.logiztek.com>';
const OWNER = 'info@logiztek.com';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST') {
      if (url.pathname === '/api/contact') return handleContact(request, env);
      if (url.pathname === '/api/submit') return handleSubmit(request, env);
    }

    // Everything else: serve the static site as-is
    return env.ASSETS.fetch(request);
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
