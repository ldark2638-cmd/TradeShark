import nodemailer from 'nodemailer';
import { config } from './config';
import { db } from './db';

export interface MailInput {
  to: string | string[];
  subject: string;
  text: string;          // plain text body (newlines become paragraphs in HTML)
  fromName?: string;     // department display name, e.g. "Compliance Desk"
  replyTo?: string;
  cta?: { label: string; url: string };
  preheader?: string;
  otp?: string;          // 6-digit one-time code, rendered as a large box in the email
  otpMinutes?: number;   // validity shown under the code
}

export type MailResult = { ok: boolean; provider: string; error?: string };

export function getActiveMailConfig() {
  const custom = db.get<any>('settings', 'mail')?.data || db.get<any>('settings', 'mail') || {};
  return {
    resendApiKey: custom.resendApiKey !== undefined ? custom.resendApiKey : config.mail.resendApiKey,
    brevoApiKey: custom.brevoApiKey !== undefined ? custom.brevoApiKey : config.mail.brevoApiKey,
    smtpHost: custom.smtpHost !== undefined ? custom.smtpHost : config.mail.smtpHost,
    smtpPort: custom.smtpPort !== undefined ? Number(custom.smtpPort) || 587 : config.mail.smtpPort,
    smtpSecure: custom.smtpSecure !== undefined ? !!custom.smtpSecure : config.mail.smtpSecure,
    smtpUser: custom.smtpUser !== undefined ? custom.smtpUser : config.mail.smtpUser,
    smtpPass: custom.smtpPass !== undefined ? custom.smtpPass : config.mail.smtpPass,
    fromAddress: custom.fromAddress || config.mail.fromAddress,
    fromAddressExplicit: custom.fromAddress ? true : config.mail.fromAddressExplicit,
    fromName: custom.fromName || config.mail.fromName,
    replyTo: custom.replyTo || config.mail.replyTo,
    loginOtp: custom.loginOtp !== undefined ? !!custom.loginOtp : config.loginOtp,
    isCustomized: !!db.get('settings', 'mail'),
  };
}

let smtpTransport: ReturnType<typeof nodemailer.createTransport> | null = null;
export const resetSmtpTransport = () => {
  smtpTransport = null;
};

const getSmtp = () => {
  if (!smtpTransport) {
    const mc = getActiveMailConfig();
    smtpTransport = nodemailer.createTransport({
      host: mc.smtpHost,
      port: mc.smtpPort,
      secure: mc.smtpSecure,
      auth: mc.smtpUser ? { user: mc.smtpUser, pass: mc.smtpPass } : undefined,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  }
  return smtpTransport;
};

type Provider = 'resend' | 'brevo' | 'smtp';

/** Configured providers in priority order. Sending falls through to the next one on failure. */
export const mailProviders = (): Provider[] => {
  const mc = getActiveMailConfig();
  const list: Provider[] = [];
  if (mc.resendApiKey) list.push('resend');
  if (mc.brevoApiKey) list.push('brevo');
  if (mc.smtpHost) list.push('smtp');
  return list;
};

export const mailProvider = (): Provider | 'log' => mailProviders()[0] || 'log';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const renderHtml = (m: MailInput) => {
  const b = config.brand;
  const paragraphs = escapeHtml(m.text)
    .split(/\n{2,}/)
    .map(p => `<p style="margin:0 0 14px;line-height:1.6;color:#d8dbd2;font-size:14px;">${p.replace(/\n/g, '<br/>')}</p>`)
    .join('');
  const otpBox = m.otp
    ? `<div style="margin:22px 0;padding:20px;background:#10130a;border:1px solid rgba(109,255,138,0.5);border-radius:14px;text-align:center;">
         <div style="font-size:11px;font-weight:700;color:#a3a89e;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;">Your one-time code</div>
         <div style="font-size:36px;font-weight:900;letter-spacing:8px;color:#6dff8a;font-family:Courier,monospace;">${escapeHtml(m.otp)}</div>
         <div style="font-size:11px;color:#868c80;margin-top:8px;">Expires in ${m.otpMinutes || 10} minutes. Never share this code with anyone.</div>
       </div>`
    : '';
  const cta = m.cta
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:22px 0 8px;"><tr><td style="border-radius:999px;background:#6dff8a;">
         <a href="${escapeHtml(m.cta.url)}" style="display:inline-block;padding:12px 26px;font-weight:700;font-size:14px;color:#15170f;text-decoration:none;border-radius:999px;">${escapeHtml(m.cta.label)}</a>
       </td></tr></table>
       <p style="margin:6px 0 0;font-size:11px;color:#868c80;">If the button does not work, copy this link: ${escapeHtml(m.cta.url)}</p>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(m.subject)}</title></head>
<body style="margin:0;padding:0;background:#0f110a;font-family:Arial,Helvetica,sans-serif;">
<span style="display:none;max-height:0;overflow:hidden;">${escapeHtml(m.preheader || m.subject)}</span>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0f110a;padding:28px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#15170f;border:1px solid #2a2e22;border-radius:18px;overflow:hidden;">
    <tr><td style="padding:22px 28px;border-bottom:1px solid #2a2e22;">
      <a href="${escapeHtml(config.appUrl)}" style="text-decoration:none;font-size:20px;font-weight:800;color:#f4f4f0;">${escapeHtml(b.appName)}<span style="color:#6dff8a;">.</span></a>
    </td></tr>
    <tr><td style="padding:28px;">
      <h1 style="margin:0 0 18px;font-size:18px;line-height:1.35;color:#ffffff;">${escapeHtml(m.subject)}</h1>
      ${paragraphs}
      ${otpBox}
      ${cta}
    </td></tr>
    <tr><td style="padding:18px 28px;background:#11130c;border-top:1px solid #2a2e22;font-size:11px;line-height:1.6;color:#868c80;">
      ${escapeHtml(b.legalName)}${b.companyNumber ? ` &middot; Company No. ${escapeHtml(b.companyNumber)}` : ''}<br/>
      ${escapeHtml(b.address)}<br/>
      Questions? <a href="mailto:${escapeHtml(b.supportEmail)}" style="color:#6dff8a;">${escapeHtml(b.supportEmail)}</a>
      &middot; <a href="${escapeHtml(config.appUrl)}" style="color:#6dff8a;">${escapeHtml(config.appUrl.replace(/^https?:\/\//, ''))}</a><br/>
      <span style="color:#5d6258;">Trading involves risk. The value of investments can go down as well as up.</span>
    </td></tr>
  </table>
</td></tr></table></body></html>`;
};

const timeout = (ms: number) => (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(ms) : undefined);

async function sendVia(provider: Provider, p: { from: string; fromName: string; recipients: string[]; subject: string; text: string; html: string; replyTo: string }): Promise<void> {
  const mc = getActiveMailConfig();
  if (provider === 'resend') {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${mc.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: p.from, to: p.recipients, subject: p.subject, text: p.text, html: p.html, reply_to: p.replyTo }),
      signal: timeout(15000),
    });
    if (!res.ok) {
      const err = await res.text();
      const hint = /domain|verify|testing emails/i.test(err)
        ? ' (verify your sending domain at resend.com/domains, or set MAIL_FROM_ADDRESS to an address on a verified domain)'
        : '';
      throw new Error(`Resend ${res.status}: ${err.slice(0, 220)}${hint}`);
    }
    return;
  }
  if (provider === 'brevo') {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': mc.brevoApiKey, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: p.fromName, email: mc.fromAddress },
        to: p.recipients.map(email => ({ email })),
        subject: p.subject, textContent: p.text, htmlContent: p.html,
        replyTo: p.replyTo ? { email: p.replyTo } : undefined,
      }),
      signal: timeout(15000),
    });
    if (!res.ok) {
      const err = await res.text();
      const hint = /sender/i.test(err) ? ' (add and verify MAIL_FROM_ADDRESS under Brevo -> Senders)' : '';
      throw new Error(`Brevo ${res.status}: ${err.slice(0, 220)}${hint}`);
    }
    return;
  }
  await getSmtp().sendMail({ from: p.from, to: p.recipients.join(', '), subject: p.subject, text: p.text, html: p.html, replyTo: p.replyTo });
}

let resendRetrying = false;

export async function sendMail(m: MailInput): Promise<MailResult> {
  const mc = getActiveMailConfig();
  const providers = mailProviders();
  const recipients = (Array.isArray(m.to) ? m.to : [m.to]).filter(Boolean);
  if (!recipients.length) return { ok: false, provider: providers[0] || 'log', error: 'No recipient' };

  const fromName = m.fromName ? `${mc.fromName} ${m.fromName}` : mc.fromName;
  const from = `${fromName} <${mc.fromAddress}>`;
  const text = m.cta ? `${m.text}\n\n${m.cta.label}: ${m.cta.url}` : m.text;
  const html = renderHtml(m);
  const replyTo = m.replyTo || mc.replyTo;

  if (!providers.length) {
    console.log(`[mail:log] (no email provider configured) To: ${recipients.join(', ')} | Subject: ${m.subject}\n${text}\n---`);
    return { ok: true, provider: 'log' };
  }
  const errors: string[] = [];
  for (const provider of providers) {
    try {
      await sendVia(provider, { from, fromName, recipients, subject: m.subject, text, html, replyTo });
      if (errors.length) console.warn(`[mail] delivered via ${provider} after: ${errors.join(' | ')}`);
      return { ok: true, provider };
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (provider === 'resend' && !resendRetrying && /domain|verify/i.test(msg)) {
        // Domain may have just been verified, or a different verified domain exists - refresh and retry once.
        resendRetrying = true;
        const before = mc.fromAddress;
        try {
          await setupResend();
          const freshMc = getActiveMailConfig();
          if (freshMc.fromAddress !== before) {
            const from2 = `${fromName} <${freshMc.fromAddress}>`;
            await sendVia('resend', { from: from2, fromName, recipients, subject: m.subject, text, html, replyTo });
            return { ok: true, provider };
          }
        } catch { /* fall through to next provider */ } finally { resendRetrying = false; }
      }
      console.error(`[mail] ${provider} failed for ${recipients.join(', ')}: ${msg}`);
      errors.push(`${provider}: ${msg}`);
    }
  }
  return { ok: false, provider: providers.join('>'), error: errors.join(' | ') };
}

/** Fire-and-forget helper so request handlers never block on mail delivery. */
export const queueMail = (m: MailInput) => {
  sendMail(m).catch(err => console.error('[mail] queue error', err));
};

// ---------- Resend auto-setup ----------
// With only RESEND_API_KEY set, we look up the domains verified in your Resend account and send from
// no-reply@<verified domain> automatically. Re-checked every 10 minutes until a domain is verified,
// so emails start flowing as soon as DNS verification completes - no redeploy needed.
export let resendStatus = '';
let resendTimer: NodeJS.Timeout | null = null;

const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

export async function setupResend(): Promise<string> {
  const mc = getActiveMailConfig();
  if (!mc.resendApiKey) return (resendStatus = '');
  try {
    const res = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${mc.resendApiKey}` },
      signal: timeout(10000),
    });
    if (res.status === 401 || res.status === 403) {
      const body = await res.text();
      if (/restricted|sending/i.test(body)) {
        const site = hostOf(config.appUrl);
        if (!mc.fromAddressExplicit && site && !site.endsWith('railway.app') && site !== 'localhost') config.mail.fromAddress = `no-reply@${site}`;
        return (resendStatus = `key is send-only, cannot list domains - sending from ${mc.fromAddress} (must be on a verified domain)`);
      }
      return (resendStatus = `RESEND_API_KEY rejected (${res.status}) - create a new key at resend.com/api-keys`);
    }
    if (!res.ok) return (resendStatus = `could not check domains (${res.status})`);
    const data: any = await res.json();
    const domains: { name: string; status: string }[] = (data?.data || []).map((d: any) => ({ name: String(d.name).toLowerCase(), status: String(d.status) }));
    const verified = domains.filter(d => d.status === 'verified').map(d => d.name);
    const currentDomain = mc.fromAddress.split('@')[1]?.toLowerCase() || '';

    if (verified.includes(currentDomain)) {
      stopResendRecheck();
      return (resendStatus = `ready - sending from ${mc.fromAddress}`);
    }
    if (verified.length) {
      const site = hostOf(config.appUrl);
      const pick = verified.find(d => d === site || site.endsWith(`.${d}`) || d.endsWith(`.${site}`)) || verified[0];
      const local = mc.fromAddressExplicit ? mc.fromAddress.split('@')[0] : 'no-reply';
      const old = mc.fromAddress;
      config.mail.fromAddress = `${local}@${pick}`;
      if (!mc.fromAddressExplicit || !process.env.MAIL_REPLY_TO) {
        // keep replies landing somewhere real on the same domain unless set explicitly
        if (config.mail.replyTo.endsWith('.up.railway.app') || config.mail.replyTo.includes('@localhost')) config.mail.replyTo = `support@${pick}`;
      }
      stopResendRecheck();
      console.log(`[mail] Resend: ${old} is not on a verified domain - using ${config.mail.fromAddress}`);
      return (resendStatus = `ready - sending from ${config.mail.fromAddress} (auto-selected verified domain ${pick})`);
    }
    scheduleResendRecheck();
    const pending = domains.find(d => d.name === currentDomain) || domains[0];
    if (pending) {
      return (resendStatus = `domain ${pending.name} is "${pending.status}" - add the DNS records shown at resend.com/domains. Until it is verified Resend only delivers to your own Resend login email. Re-checking every 10 min.`);
    }
    return (resendStatus = `no domain added - add ${hostOf(config.appUrl) || 'your domain'} at resend.com/domains and add its DNS records. Re-checking every 10 min.`);
  } catch (e: any) {
    scheduleResendRecheck();
    return (resendStatus = `could not reach Resend (${e?.message || e}) - will retry`);
  }
}

function scheduleResendRecheck() {
  if (resendTimer) return;
  resendTimer = setInterval(async () => {
    const before = resendStatus;
    const now = await setupResend();
    if (now !== before) console.log(`[mail] Resend: ${now}`);
  }, 10 * 60000);
}
function stopResendRecheck() {
  if (resendTimer) { clearInterval(resendTimer); resendTimer = null; }
}

export async function verifyMailer(): Promise<string> {
  const list = mailProviders();
  if (!list.length) return 'log (NO EMAIL PROVIDER CONFIGURED - emails and login codes are only printed to these logs)';
  const parts: string[] = [];
  for (const p of list) {
    if (p === 'smtp') {
      try { await getSmtp().verify(); parts.push('smtp (verified)'); } catch (e: any) { parts.push(`smtp (verify failed: ${e?.message})`); }
    } else if (p === 'resend') {
      parts.push(`resend (${await setupResend()})`);
    } else parts.push(p);
  }
  return parts.join(' > ');
}
