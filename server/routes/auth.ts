import { Router, Request } from 'express';
import { db, newId } from '../db';
import { config } from '../config';
import {
  hashPassword, checkPassword, issueUserSession, issueAdminSession, clearUserSession, clearAdminSession,
  getUserFromReq, getAdminFromReq, requireUser, randomToken, sha256, publicAdmin, AdminRecord,
} from '../auth';
import { audit, baseUserRecord, findUserByEmail, findUserByLogin, notifyAdmins, publicUser, createMessage } from '../services';
import { queueMail, sendMail, mailProvider } from '../mailer';
import crypto from 'crypto';
import { rateLimit } from '../rateLimit';

export const authRouter = Router();

const clientIp = (req: Request) => (req.ip || '').replace('::ffff:', '');
const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

export async function createToken(type: 'reset' | 'verify' | 'setup', userId: string, ttlHours: number) {
  // invalidate previous tokens of the same type
  for (const t of db.filter<any>('tokens', t => t.userId === userId && t.type === type)) await db.remove('tokens', t.id);
  const raw = randomToken();
  await db.put('tokens', { id: sha256(raw), type, userId, expires: Date.now() + ttlHours * 3600000 });
  return raw;
}

async function consumeToken(raw: string, types: string[]) {
  const t = db.get<any>('tokens', sha256(String(raw || '')));
  if (!t || !types.includes(t.type) || t.expires < Date.now()) return null;
  await db.remove('tokens', t.id);
  return t;
}

// Email verification: 6-digit code (stored hashed, 15 min, 5 attempts) plus a fallback link.
const REG_OTP_MINUTES = 15;
const regOtpId = (userId: string) => `regotp:${userId}`;
const regOtpHash = (userId: string, code: string) => sha256(`regotp:${userId}:${code}:${config.jwtSecret}`);

export async function createOtpToken(userId: string): Promise<string> {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await db.put('otps', { id: regOtpId(userId), kind: 'register', userId, codeHash: regOtpHash(userId, code), attempts: 0, expires: Date.now() + REG_OTP_MINUTES * 60000, lastSent: Date.now() });
  return code;
}

export async function sendVerificationEmail(user: any, otpCode?: string) {
  const token = await createToken('verify', user.id, 72);
  const otp = otpCode || (await createOtpToken(user.id));
  const r = await sendMail({
    to: user.email,
    subject: `${otp} is your ${config.brand.appName} verification code`,
    fromName: 'Security',
    preheader: `Your verification code is ${otp}`,
    otp,
    otpMinutes: REG_OTP_MINUTES,
    text: `Hi ${user.name},\n\nThanks for opening a ${config.brand.appName} account. Enter this code on the verification screen to activate it.\n\nOr verify with the button below. If you did not create this account, ignore this email.`,
    cta: { label: 'Verify email address', url: `${config.appUrl}/verify-email?token=${token}` },
  });
  if (mailProvider() === 'log') console.log(`[otp] Verification code for ${user.email}: ${otp} (no email provider configured)`);
  if (!r.ok) console.error(`[otp] failed to email verification code to ${user.email}: ${r.error}`);
  return { token, otp, ok: r.ok };
}

// ---------------- USER ----------------
authRouter.post('/register', rateLimit('register', 10, 3600), async (req, res) => {
  const { name, email, password, phone, country, remember, ref } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Please enter your full name.' });
  if (!emailOk(cleanEmail)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (String(password || '').length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (findUserByEmail(cleanEmail)) return res.status(409).json({ error: 'An account with this email already exists. Please log in instead.' });

  const referrer = ref ? db.get<any>('users', String(ref).toUpperCase()) : null;
  const user: any = baseUserRecord({
    name, email: cleanEmail, passwordHash: await hashPassword(password), phone, country, referredBy: referrer?.id,
  });
  user.lastIp = clientIp(req);
  user.referralCode = user.id;
  await db.put('users', user);
  await audit('Self-Registration', 'Account Created', `New client ${user.name} (${user.email}) registered online from ${user.country || 'unknown country'}.`, 'USER_MGMT', `${user.id} (${user.name})`);

  await createMessage({
    userId: user.id,
    category: 'ACCOUNT',
    direction: 'outbound',
    subject: `Welcome to ${config.brand.appName}, ${user.name.split(' ')[0]}!`,
    body: `Dear ${user.name},\n\nWelcome to ${config.brand.appName}. Your trading account ${user.id} is ready.\n\nNext steps:\n1. Verify your email address with the 6-digit code we sent you.\n2. Complete identity verification (KYC) in the Verification Centre.\n3. Fund your account and start trading - or practise first with your ${'$'}${config.practiceBalance.toLocaleString()} virtual account.\n\nIf you have any questions, reply to this email or contact ${config.brand.supportEmail}.\n\nThe ${config.brand.appName} Team`,
    cta: { label: 'Open your client portal', url: `${config.appUrl}/dashboard` },
  });
  const sent = await sendVerificationEmail(user);
  notifyAdmins(`New registration: ${user.name}`, `${user.name} (${user.email}) just registered.\nAccount: ${user.id}\nCountry: ${user.country || '-'}\nPhone: ${user.phone || '-'}${referrer ? `\nReferred by: ${referrer.name} (${referrer.id})` : ''}`, { label: 'Open admin console', url: `${config.appUrl}/admin` });

  // No session until the email code is entered - stops throwaway / fake-email signups.
  res.json({
    user: publicUser(user),
    requireOtp: true,
    otpEmail: cleanEmail,
    emailSent: sent.ok,
    message: sent.ok ? `We sent a 6-digit code to ${cleanEmail}.` : 'Your account was created but we could not email your code yet. Tap "Resend code" in a moment.',
  });
});

authRouter.post('/verify-otp', rateLimit('verify-otp', 30, 900), async (req, res) => {
  const cleanEmail = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.otp || '').replace(/\D/g, '');
  if (!cleanEmail || code.length !== 6) return res.status(400).json({ error: 'Enter the 6-digit code from your email.' });
  const user = findUserByEmail(cleanEmail);
  const rec = user ? db.get<any>('otps', regOtpId(user.id)) : null;
  if (!user || !rec || rec.expires < Date.now()) {
    return res.status(400).json({ error: 'This code has expired. Tap "Resend code" to get a new one.' });
  }
  const a = Buffer.from(regOtpHash(user.id, code));
  const b = Buffer.from(rec.codeHash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const attempts = (rec.attempts || 0) + 1;
    if (attempts >= 5) {
      await db.remove('otps', rec.id);
      return res.status(400).json({ error: 'Too many incorrect codes. Tap "Resend code" to get a new one.' });
    }
    await db.update('otps', rec.id, { attempts });
    return res.status(400).json({ error: `Incorrect code. ${5 - attempts} attempt${5 - attempts === 1 ? '' : 's'} left.` });
  }
  await db.remove('otps', rec.id);
  if (user.status === 'Suspended') return res.status(403).json({ error: `This account is suspended. Please contact ${config.brand.supportEmail}.` });
  await db.update('users', user.id, { emailVerified: true, lastIp: clientIp(req), lastLogin: new Date().toISOString() });
  await audit('Email Verified', 'OTP Verification', `Client ${user.name} (${user.email}) verified their email with a 6-digit code.`, 'USER_MGMT', `${user.id} (${user.name})`);
  const expiresAt = issueUserSession(res, user.id, true);
  res.json({ ok: true, message: `Email verified. Welcome to ${config.brand.appName}!`, user: publicUser(db.get('users', user.id)), expiresAt });
});

authRouter.post('/resend-otp', rateLimit('resend-otp', 10, 900), async (req, res) => {
  const cleanEmail = String(req.body?.email || '').trim().toLowerCase();
  if (!cleanEmail) return res.status(400).json({ error: 'Email address is required.' });
  const generic = { ok: true, message: `If an account exists for ${cleanEmail}, a new code has been sent.` };
  const user = findUserByEmail(cleanEmail);
  if (!user || user.emailVerified) return res.json(generic);
  const prev = db.get<any>('otps', regOtpId(user.id));
  const wait = prev ? 30000 - (Date.now() - (prev.lastSent || 0)) : 0;
  if (wait > 0) return res.status(429).json({ error: `Please wait ${Math.ceil(wait / 1000)}s before requesting another code.` });
  const r = await sendVerificationEmail(user);
  if (!r.ok) return res.status(502).json({ error: 'We could not email your code right now. Please try again shortly.' });
  res.json({ ok: true, message: `A new 6-digit code has been sent to ${cleanEmail}.` });
});

authRouter.post('/request-email-otp', requireUser, rateLimit('req-otp', 10, 900), async (req, res) => {
  const user = (req as any).user;
  if (user.emailVerified) return res.json({ ok: true, message: 'Your email is already verified.' });
  const r = await sendVerificationEmail(user);
  if (!r.ok) return res.status(502).json({ error: 'We could not email your code right now. Please try again shortly.' });
  res.json({ ok: true, message: `A new 6-digit code has been sent to ${user.email}.` });
});

// ---------- Login: password -> emailed one-time code -> session ----------
const maskEmail = (e: string) => {
  const [u, d] = e.split('@');
  if (!d) return e;
  return `${u.slice(0, 2)}${'*'.repeat(Math.max(1, u.length - 2))}@${d}`;
};
const otpHash = (challengeId: string, code: string) => sha256(`${challengeId}:${code}:${config.jwtSecret}`);
const newOtpCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

async function sendLoginCode(user: any, code: string) {
  const r = await sendMail({
    to: user.email,
    subject: `${code} is your ${config.brand.appName} sign-in code`,
    fromName: 'Security',
    preheader: `Your sign-in code is ${code}`,
    text: `Hi ${user.name},\n\nUse this code to finish signing in to your ${config.brand.appName} account:\n\n${code}\n\nThe code expires in ${config.otpTtlMinutes} minutes and can only be used once.\n\nIf you did not try to sign in, someone may know your password. Reset it now and contact ${config.brand.supportEmail}.`,
  });
  if (mailProvider() === 'log') console.log(`[otp] Login code for ${user.email}: ${code} (no email provider configured - code printed to logs)`);
  if (!r.ok) console.error(`[otp] failed to email code to ${user.email}: ${r.error}`);
  return r;
}

async function registerFailedLogin(user: any) {
  const fails = (user.failedLogins || 0) + 1;
  const patch: any = { failedLogins: fails };
  if (fails >= config.maxFailedLogins) {
    patch.lockedUntil = Date.now() + config.lockoutMinutes * 60000;
    patch.failedLogins = 0;
    queueMail({
      to: user.email,
      subject: `Your ${config.brand.appName} account was temporarily locked`,
      fromName: 'Security',
      text: `Hi ${user.name},\n\nWe locked sign-in to your account for ${config.lockoutMinutes} minutes after several failed attempts.\n\nIf this wasn't you, reset your password now.`,
      cta: { label: 'Reset password', url: `${config.appUrl}/forgot-password` },
    });
    await audit('Security', 'Account Locked', `${config.maxFailedLogins} failed sign-in attempts - locked for ${config.lockoutMinutes} min.`, 'COMPLIANCE', `${user.id} (${user.name})`);
  }
  await db.update('users', user.id, patch);
}

async function completeLogin(req: Request, res: any, user: any, remember: boolean) {
  const ip = clientIp(req);
  await db.update('users', user.id, { lastIp: ip, lastLogin: new Date().toISOString(), failedLogins: 0, lockedUntil: 0 });
  if (config.mail.loginAlerts) {
    queueMail({
      to: user.email,
      subject: `New sign-in to your ${config.brand.appName} account`,
      fromName: 'Security',
      text: `Hi ${user.name},\n\nWe noticed a new sign-in to your account.\n\nTime: ${new Date().toUTCString()}\nIP address: ${ip}\n\nIf this was you, no action is needed. If not, reset your password immediately and contact ${config.brand.supportEmail}.`,
      cta: { label: 'Reset password', url: `${config.appUrl}/forgot-password` },
    });
  }
  const expiresAt = issueUserSession(res, user.id, remember);
  return res.json({ user: publicUser(db.get('users', user.id)), expiresAt });
}

authRouter.post('/login', rateLimit('login', 20, 900), async (req, res) => {
  const { identifier, email, password, remember } = req.body || {};
  const user = findUserByLogin(String(identifier || email || ''));
  if (user && user.lockedUntil && user.lockedUntil > Date.now()) {
    const mins = Math.ceil((user.lockedUntil - Date.now()) / 60000);
    return res.status(423).json({ error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}, or reset your password.` });
  }
  if (!user || !(await checkPassword(String(password || ''), user.passwordHash))) {
    if (user) await registerFailedLogin(user);
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  if (user.status === 'Suspended') {
    return res.status(403).json({ error: `This account is suspended. Please contact ${config.brand.supportEmail}.` });
  }
  if (config.requireEmailVerification && !user.emailVerified) {
    await sendVerificationEmail(user);
    return res.status(403).json({ error: 'Please verify your email address first. We just sent you a new verification link.' });
  }
  if (!config.loginOtp) return completeLogin(req, res, user, !!remember);

  // Step 2: email a one-time code
  for (const o of db.filter<any>('otps', o => o.userId === user.id || o.expires < Date.now())) await db.remove('otps', o.id);
  const challengeId = randomToken();
  const code = newOtpCode();
  await db.put('otps', {
    id: challengeId, userId: user.id, codeHash: otpHash(challengeId, code), remember: !!remember,
    expires: Date.now() + config.otpTtlMinutes * 60000, attempts: 0, sends: 1, lastSent: Date.now(), ip: clientIp(req),
  });
  const r = await sendLoginCode(user, code);
  if (!r.ok) {
    await db.remove('otps', challengeId);
    return res.status(502).json({ error: 'We could not email your sign-in code right now. Please try again in a moment or contact support.' });
  }
  res.json({ otpRequired: true, challengeId, email: maskEmail(user.email), expiresInMinutes: config.otpTtlMinutes });
});

authRouter.post('/login/verify', rateLimit('login-otp', 30, 900), async (req, res) => {
  const { challengeId, code } = req.body || {};
  const ch = db.get<any>('otps', String(challengeId || ''));
  if (!ch || ch.expires < Date.now()) {
    if (ch) await db.remove('otps', ch.id);
    return res.status(400).json({ error: 'This code has expired. Please sign in again to get a new one.', restart: true });
  }
  const clean = String(code || '').replace(/\D/g, '');
  const a = Buffer.from(otpHash(ch.id, clean));
  const b = Buffer.from(ch.codeHash);
  if (clean.length !== 6 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const attempts = (ch.attempts || 0) + 1;
    if (attempts >= 5) {
      await db.remove('otps', ch.id);
      const u = db.get<any>('users', ch.userId);
      if (u) await registerFailedLogin(u);
      return res.status(400).json({ error: 'Too many incorrect codes. Please sign in again.', restart: true });
    }
    await db.update('otps', ch.id, { attempts });
    return res.status(400).json({ error: `Incorrect code. ${5 - attempts} attempt${5 - attempts === 1 ? '' : 's'} left.` });
  }
  await db.remove('otps', ch.id);
  const user = db.get<any>('users', ch.userId);
  if (!user || user.status === 'Suspended') return res.status(403).json({ error: 'This account cannot sign in. Please contact support.', restart: true });
  if (!user.emailVerified) await db.update('users', user.id, { emailVerified: true }); // code proves inbox ownership
  return completeLogin(req, res, db.get('users', user.id), !!ch.remember);
});

authRouter.post('/login/resend', rateLimit('login-otp-resend', 10, 900), async (req, res) => {
  const ch = db.get<any>('otps', String(req.body?.challengeId || ''));
  if (!ch || ch.expires < Date.now()) return res.status(400).json({ error: 'This sign-in has expired. Please sign in again.', restart: true });
  const wait = 60000 - (Date.now() - (ch.lastSent || 0));
  if (wait > 0) return res.status(429).json({ error: `Please wait ${Math.ceil(wait / 1000)}s before requesting another code.` });
  if ((ch.sends || 1) >= 5) return res.status(429).json({ error: 'Too many codes requested. Please sign in again.', restart: true });
  const user = db.get<any>('users', ch.userId);
  if (!user) return res.status(400).json({ error: 'Account not found.', restart: true });
  const code = newOtpCode();
  await db.update('otps', ch.id, {
    codeHash: otpHash(ch.id, code), attempts: 0, sends: (ch.sends || 1) + 1, lastSent: Date.now(),
    expires: Date.now() + config.otpTtlMinutes * 60000,
  });
  const r = await sendLoginCode(user, code);
  if (!r.ok) return res.status(502).json({ error: 'We could not email your code. Please try again shortly.' });
  res.json({ ok: true, message: `A new code was sent to ${maskEmail(user.email)}.` });
});

authRouter.post('/logout', (_req, res) => {
  clearUserSession(res);
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  const s = getUserFromReq(req);
  if (!s) return res.json({ user: null });
  res.json({ user: publicUser(s.user), expiresAt: s.expiresAt });
});

authRouter.post('/forgot-password', rateLimit('forgot', 5, 900), async (req, res) => {
  const user = findUserByEmail(String(req.body?.email || ''));
  if (user) {
    const token = await createToken('reset', user.id, 1);
    queueMail({
      to: user.email,
      subject: `Reset your ${config.brand.appName} password`,
      fromName: 'Security',
      text: `Hi ${user.name},\n\nWe received a request to reset the password for your account. Click the button below to choose a new password. This link expires in 1 hour.\n\nIf you did not request this, you can safely ignore this email - your password will not change.`,
      cta: { label: 'Reset password', url: `${config.appUrl}/reset-password?token=${token}` },
    });
  }
  // Always respond the same way to avoid revealing which emails are registered.
  res.json({ ok: true, message: 'If an account exists for that email, a password reset link has been sent.' });
});

authRouter.post('/reset-password', rateLimit('reset', 10, 900), async (req, res) => {
  const { token, password } = req.body || {};
  if (String(password || '').length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  const t = await consumeToken(token, ['reset', 'setup']);
  if (!t) return res.status(400).json({ error: 'This link is invalid or has expired. Please request a new one.' });
  const user = db.get<any>('users', t.userId);
  if (!user) return res.status(400).json({ error: 'Account not found.' });
  await db.update('users', user.id, { passwordHash: await hashPassword(password), emailVerified: true, sessionVersion: (user.sessionVersion || 0) + 1, failedLogins: 0, lockedUntil: 0 });
  queueMail({
    to: user.email,
    subject: `Your ${config.brand.appName} password was changed`,
    fromName: 'Security',
    text: `Hi ${user.name},\n\nThe password for your account was just changed. If you did not do this, contact ${config.brand.supportEmail} immediately.`,
  });
  const expiresAt = issueUserSession(res, user.id, false);
  res.json({ ok: true, user: publicUser(db.get('users', user.id)), expiresAt });
});

authRouter.post('/verify-email', async (req, res) => {
  const t = await consumeToken(req.body?.token, ['verify']);
  if (!t) return res.status(400).json({ error: 'This verification link is invalid or has expired.' });
  await db.update('users', t.userId, { emailVerified: true });
  res.json({ ok: true });
});

authRouter.post('/resend-verification', requireUser, rateLimit('resend', 5, 3600), async (req, res) => {
  const user = (req as any).user;
  if (user.emailVerified) return res.json({ ok: true, message: 'Your email is already verified.' });
  await sendVerificationEmail(user);
  res.json({ ok: true, message: `Verification code and link sent to ${user.email}.` });
});

authRouter.post('/change-password', requireUser, async (req, res) => {
  const user = (req as any).user;
  const { currentPassword, newPassword } = req.body || {};
  if (!(await checkPassword(String(currentPassword || ''), user.passwordHash))) return res.status(400).json({ error: 'Current password is incorrect.' });
  if (String(newPassword || '').length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  await db.update('users', user.id, { passwordHash: await hashPassword(newPassword), sessionVersion: (user.sessionVersion || 0) + 1 });
  issueUserSession(res, user.id, true); // keep this device signed in, revoke all others
  queueMail({
    to: user.email,
    subject: `Your ${config.brand.appName} password was changed`,
    fromName: 'Security',
    text: `Hi ${user.name},\n\nThe password for your account was just changed from your client portal. If you did not do this, contact ${config.brand.supportEmail} immediately.`,
  });
  res.json({ ok: true });
});

authRouter.post('/profile', requireUser, async (req, res) => {
  const user = (req as any).user;
  const { phone, country, streetAddress, city, postalCode } = req.body || {};
  const patch: any = {};
  if (typeof phone === 'string') patch.phone = phone.trim();
  if (typeof country === 'string') patch.country = country.trim();
  if (typeof streetAddress === 'string') patch.streetAddress = streetAddress.trim();
  if (typeof city === 'string') patch.city = city.trim();
  if (typeof postalCode === 'string') patch.postalCode = postalCode.trim();
  await db.update('users', user.id, patch);
  res.json({ user: publicUser(db.get('users', user.id)) });
});

// ---------------- ADMIN ----------------
authRouter.post('/admin/login', rateLimit('admin-login', 10, 900), async (req, res) => {
  const { username, password, remember } = req.body || {};
  const u = String(username || '').trim().toLowerCase();
  const admin = db.find<AdminRecord>('admins', a => a.username === u || a.email.toLowerCase() === u);
  if (!admin || !(await checkPassword(String(password || ''), admin.passwordHash))) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  const expiresAt = issueAdminSession(res, admin.id, !!remember);
  await audit(`${admin.name} (${admin.role})`, 'Admin Sign-in', `Back-office session opened from ${clientIp(req)}.`, 'COMPLIANCE');
  res.json({ admin: publicAdmin(admin), expiresAt });
});

authRouter.post('/admin/logout', (_req, res) => {
  clearAdminSession(res);
  res.json({ ok: true });
});

authRouter.get('/admin/me', (req, res) => {
  const s = getAdminFromReq(req);
  if (!s) return res.json({ admin: null });
  res.json({ admin: publicAdmin(s.admin), expiresAt: s.expiresAt });
});

authRouter.post('/admin/change-password', async (req, res) => {
  const s = getAdminFromReq(req);
  if (!s) return res.status(401).json({ error: 'Not signed in.' });
  const { currentPassword, newPassword } = req.body || {};
  if (!(await checkPassword(String(currentPassword || ''), s.admin.passwordHash))) return res.status(400).json({ error: 'Current password is incorrect.' });
  if (String(newPassword || '').length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  await db.update('admins', s.admin.id, { passwordHash: await hashPassword(newPassword) });
  res.json({ ok: true, note: 'Password changed. Note: if this account is configured via environment variables, the env value is re-applied on the next restart.' });
});

export { newId };
