const nodemailer = require('nodemailer');

let transporter = null;
let from = process.env.SMTP_FROM || 'Control <control@example.com>';
let baseUrl = process.env.BASE_URL || 'http://localhost:3000';

function init() {
  baseUrl = process.env.BASE_URL || baseUrl;
  if (!process.env.SMTP_HOST) {
    console.log('[mail] SMTP_HOST not set — notifications will be logged to the container log only.');
    return;
  }
  const port = Number(process.env.SMTP_PORT || 587);
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined
  });
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function wrap(title, bodyHtml) {
  return `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#12121a;color:#e8e4ee;padding:24px">
  <div style="max-width:520px;margin:0 auto;background:#1b1b26;border:1px solid #2e2e3e;border-radius:12px;padding:24px">
    <div style="font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:#c58a9a;margin-bottom:12px">Control</div>
    <h2 style="margin:0 0 16px;font-size:18px;color:#efe9f1">${esc(title)}</h2>
    <div style="font-size:14px;line-height:1.6">${bodyHtml}</div>
    <div style="margin-top:24px;font-size:12px;color:#7d7890"><a style="color:#c58a9a" href="${baseUrl}">Open Control</a></div>
  </div></body></html>`;
}

async function send(to, subject, bodyHtml) {
  if (!transporter || !to) {
    console.log(`[mail] (${transporter ? 'no recipient' : 'SMTP off'}) to=${to || 'none'} — ${subject}`);
    return;
  }
  try {
    await transporter.sendMail({ from, to, subject, html: wrap(subject, bodyHtml) });
  } catch (err) {
    console.error(`[mail] failed to send to ${to}:`, err.message);
  }
}

module.exports = { init, send, esc, smtpEnabled: () => !!transporter };