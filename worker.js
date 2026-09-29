// Cloudflare Worker — serves the static site and handles form submissions.
// This replaces the old functions/api/submit.js approach, which only
// works on Cloudflare "Pages" projects, not plain Workers deployments.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/submit' && request.method === 'POST') {
      return handleSubmit(request, env);
    }

    // Everything else: serve the static site as-is
    return env.ASSETS.fetch(request);
  }
};

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

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
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
        from: 'Logiztek <notifications@mail.logiztek.com>',
        to: ['info@logiztek.com'],
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

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
