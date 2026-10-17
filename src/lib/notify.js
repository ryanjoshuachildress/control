// Single notification dispatcher. Every "something happened" site calls
// notifyUser(userId, { subject, html, ... }) and this module decides which
// channels fire and whether the user opted in:
//   email — mail.js (SMTP on, per-user email_notifications, household SMTP
//           master switch on the Dom's row)
//   SMS   — sms.js through the household's OpenSMS gateway (gateway
//           configured, per-user phone + sms_notifications)
// html is the email body (same rich template as before, viewLink included);
// label — kept accepted at call sites but unused in SMS bodies since shortening.
// plain text + link are derived for SMS. Fire-and-forget like the old
// mail.send call sites, with its own error log so no route is held up.
const db = require('../db');
const mail = require('./mail');
const sms = require('./sms');

// The household row is the Dom's row (their own when dom_id is null): it
// holds the smtp_notifications master switch and the SMS gateway config.
function householdQuery(userId) {
  return db.get(`
    SELECT u.id, u.email, u.phone, u.email_notifications, u.sms_notifications, u.dom_id,
           d.smtp_notifications AS smtp_master, d.sms_gateway_url AS gw_url, d.sms_gateway_token AS gw_token
    FROM users u
    LEFT JOIN users d ON d.id = COALESCE(u.dom_id, u.id)
    WHERE u.id = ?`, userId);
}

// The gateway's paired device delivers single-segment SMS reliably but drops
// multi-part (long) messages, so texts are built ASCII-only, subject truncated
// first, deep link kept whole, kept on one GSM-7 segment (≤160 chars).
const smsSafe = (s) => String(s || '')
  .replace(/[’‘]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[—–]/g, '-')
  .replace(/…/g, '...')
  .replace(/[^\x20-\x7E]/g, '');

function smsText(subject, path) {
  let text = smsSafe(subject);
  if (path) {
    let host = process.env.BASE_URL || 'http://localhost:3000';
    try { host = new URL(host).host; } catch { /* keep raw */ }
    const suffix = ` - ${smsSafe(host)}/#/${smsSafe(path)}`;
    const room = Math.max(160 - suffix.length, 0);
    text = text.slice(0, room) + suffix;
  }
  return text.slice(0, 160);
}

async function notifyUser(userId, { subject, html, path, label }) {
  if (!userId) return;
  try {
    const u = await householdQuery(userId);
    if (!u) return;

    // Email: the per-user toggle AND the household master switch must both be
    // on (the switch defaults to on, so it only suppresses when the Dom sets
    // it that way). mail.send logs to the container log when SMTP itself is
    // off — the tests assert on that line — so no smtpEnabled() gate here.
    if (u.email_notifications && u.smtp_master) {
      await mail.send(u.email, subject, html);
    }

    // SMS: the user's own opt-in and number first; the gateway comes from the
    // household's config, falling back to OSMS_URL/OSMS_TOKEN for a fresh
    // install. No gateway → sms.send logs the message (the off-path signal).
    if (u.sms_notifications && u.phone) {
      let gateway = null;
      if (u.gw_url && u.gw_token) gateway = { url: u.gw_url, token: u.gw_token };
      else if (process.env.OSMS_URL && process.env.OSMS_TOKEN) {
        gateway = { url: process.env.OSMS_URL, token: process.env.OSMS_TOKEN };
      }
      await sms.send(u.phone, smsText(subject, path), gateway, subject);
    }
  } catch (err) {
    console.error('[notify] failed for', userId, err);
  }
}

module.exports = { notifyUser, householdQuery, smsText };