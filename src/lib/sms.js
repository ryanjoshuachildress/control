// SMS delivery through the household's OpenSMS gateway. The gateway config
// (full endpoint URL + bearer token) lives on the Dom's row and is passed in
// by notify.js; when there's no gateway the message is logged to the
// container log the same way mail.js logs with SMTP off.
//   POST <url>   {"number": "+1619…", "text": "…"}   Authorization: Bearer <token>
async function send(number, text, gateway, subject) {
  if (!gateway || !gateway.url || !gateway.token || !number) {
    console.log(`[sms] (gateway off) to=${number || 'none'} — ${subject || text}`);
    return;
  }
  try {
    const res = await fetch(gateway.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${gateway.token}`
      },
      body: JSON.stringify({ number, text: String(text || '').slice(0, 400) }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) console.error(`[sms] gateway returned ${res.status} for ${number}`);
    else console.log(`[sms] sent to ${number} — ${subject || text.slice(0, 60)}`);
  } catch (err) {
    console.error(`[sms] failed to send to ${number}:`, err.message);
  }
}

module.exports = { send };