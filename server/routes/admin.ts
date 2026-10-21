import { Router } from 'express';
import { db } from '../db';
import { config } from '../config';
import { requireAdmin, issueUserSession, AdminRecord } from '../auth';
import {
  adminState, audit, approveKyc, rejectKyc, requestKycResubmit, approveFunding, rejectFunding,
  manualAdjustment, createMessage, markMessageRead, closePosition, setAssetHalt, savePaymentSettings,
  baseUserRecord, findUserByEmail, publicUser, HttpError, Category, stopCopy, adminStartCopy,
} from '../services';
import { createToken } from './auth';
import { sendMail, verifyMailer, mailProviders, resendStatus, getActiveMailConfig, resetSmtpTransport } from '../mailer';
import { listInvestors, createInvestor, updateInvestor, deleteInvestor, adjustCopy, resetInvestorIndex, listAllCopies } from '../copytrader';

export const adminRouter = Router();

const actorOf = (req: any) => {
  const a = req.admin as AdminRecord;
  return `${a.name} (${a.role})`;
};

const wrap = (fn: (req: any, res: any) => Promise<any>) => (req: any, res: any) =>
  fn(req, res).catch((e: any) => {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Something went wrong.' });
  });

const mustUser = (id: string) => {
  const u = db.get<any>('users', id);
  if (!u) throw new HttpError(404, 'User not found.');
  return u;
};

adminRouter.get('/state', requireAdmin(), (_req, res) => res.json(adminState()));

// ---------- Email delivery diagnostics & configuration ----------
adminRouter.get('/mail/status', requireAdmin('emails'), wrap(async (_req, res) => {
  const mc = getActiveMailConfig();
  res.json({
    providers: mailProviders(),
    status: await verifyMailer(),
    resend: resendStatus,
    fromAddress: mc.fromAddress,
    fromName: mc.fromName,
    loginOtp: mc.loginOtp,
    isCustomized: mc.isCustomized,
  });
}));

adminRouter.get('/mail/config', requireAdmin('emails'), wrap(async (_req, res) => {
  const mc = getActiveMailConfig();
  res.json({
    config: {
      smtpHost: mc.smtpHost || '',
      smtpPort: mc.smtpPort || 587,
      smtpSecure: mc.smtpSecure,
      smtpUser: mc.smtpUser || '',
      smtpPass: mc.smtpPass ? '••••••••' : '',
      fromAddress: mc.fromAddress || '',
      fromName: mc.fromName || '',
      replyTo: mc.replyTo || '',
      resendApiKey: mc.resendApiKey ? '••••••••' : '',
      brevoApiKey: mc.brevoApiKey ? '••••••••' : '',
      loginOtp: mc.loginOtp,
      isCustomized: mc.isCustomized,
    },
    providers: mailProviders(),
  });
}));

adminRouter.put('/mail/config', requireAdmin('emails'), wrap(async (req, res) => {
  const b = req.body || {};
  const current = db.get<any>('settings', 'mail')?.data || {};
  const patch: any = { ...current };

  if (b.smtpHost !== undefined) patch.smtpHost = String(b.smtpHost).trim();
  if (b.smtpPort !== undefined) patch.smtpPort = Number(b.smtpPort) || 587;
  if (b.smtpSecure !== undefined) patch.smtpSecure = !!b.smtpSecure;
  if (b.smtpUser !== undefined) patch.smtpUser = String(b.smtpUser).trim();
  if (b.smtpPass !== undefined && b.smtpPass !== '••••••••' && b.smtpPass !== '') patch.smtpPass = String(b.smtpPass);
  if (b.fromAddress !== undefined) patch.fromAddress = String(b.fromAddress).trim();
  if (b.fromName !== undefined) patch.fromName = String(b.fromName).trim();
  if (b.replyTo !== undefined) patch.replyTo = String(b.replyTo).trim();
  if (b.resendApiKey !== undefined && b.resendApiKey !== '••••••••') patch.resendApiKey = String(b.resendApiKey).trim();
  if (b.brevoApiKey !== undefined && b.brevoApiKey !== '••••••••') patch.brevoApiKey = String(b.brevoApiKey).trim();
  if (b.loginOtp !== undefined) patch.loginOtp = !!b.loginOtp;

  await db.put('settings', { id: 'mail', data: patch });
  resetSmtpTransport();
  await audit(actorOf(req), 'Mail Config Updated', `Saved dynamic mail settings (host: ${patch.smtpHost || 'none'}, from: ${patch.fromAddress || 'default'}).`, 'COMPLIANCE');

  res.json({
    ok: true,
    message: 'Mail settings saved successfully.',
    providers: mailProviders(),
    status: await verifyMailer(),
  });
}));

adminRouter.post('/mail/reset', requireAdmin('emails'), wrap(async (req, res) => {
  await db.remove('settings', 'mail');
  resetSmtpTransport();
  await audit(actorOf(req), 'Mail Config Reset', 'Reset mailer settings to environment defaults.', 'COMPLIANCE');
  res.json({
    ok: true,
    message: 'Mail settings reset to environment defaults.',
    providers: mailProviders(),
    status: await verifyMailer(),
  });
}));

adminRouter.post('/mail/test', requireAdmin('emails'), wrap(async (req, res) => {
  const to = String(req.body?.to || (req.admin as AdminRecord).email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) throw new HttpError(400, 'Enter a valid email address to send the test to.');
  const r = await sendMail({
    to,
    subject: `${config.brand.appName} test email`,
    fromName: 'System',
    text: `This is a test email from your ${config.brand.appName} admin console.\n\nIf you received it, outgoing email (including login codes) is working.`,
  });
  await audit(actorOf(req), 'Email Test', `Test email to ${to}: ${r.ok ? `sent via ${r.provider}` : `FAILED - ${r.error}`}`, 'COMPLIANCE');
  if (!r.ok) return res.status(502).json({ ok: false, error: r.error, provider: r.provider });
  res.json({ ok: true, provider: r.provider, message: r.provider === 'log' ? 'No email provider is configured - the email was only written to the server logs.' : `Test email sent to ${to} via ${r.provider}.` });
}));

// ---------- CopyTrader management ----------
adminRouter.get('/investors', requireAdmin(), (_req, res) => res.json({ investors: listInvestors(true) }));

adminRouter.post('/investors', requireAdmin('users.write'), wrap(async (req, res) => {
  if (!String(req.body?.name || '').trim()) throw new HttpError(400, 'Investor name is required.');
  const inv = await createInvestor(req.body || {}).catch((e: any) => { throw new HttpError(400, e?.message || 'Invalid investor details.'); });
  await audit(actorOf(req), 'Investor Added', `Added Popular Investor ${inv.name} (${inv.handle}).`, 'MARKET');
  res.json({ investors: listInvestors(true) });
}));

adminRouter.put('/investors/:id', requireAdmin('users.write'), wrap(async (req, res) => {
  const inv = await updateInvestor(req.params.id, req.body || {}).catch((e: any) => { throw new HttpError(400, e?.message || 'Invalid investor details.'); });
  if (!inv) throw new HttpError(404, 'Investor not found.');
  await audit(actorOf(req), 'Investor Updated', `Updated Popular Investor ${inv.name} (${inv.handle}).`, 'MARKET');
  res.json({ investors: listInvestors(true) });
}));

adminRouter.delete('/investors/:id', requireAdmin('users.write'), wrap(async (req, res) => {
  const r = await deleteInvestor(req.params.id);
  await audit(actorOf(req), r.hidden ? 'Investor Hidden' : 'Investor Deleted', `${req.params.id} ${r.hidden ? 'hidden (has active copiers)' : 'deleted'}.`, 'MARKET');
  res.json({ ...r, investors: listInvestors(true) });
}));

adminRouter.post('/investors/:id/reset-index', requireAdmin('users.write'), wrap(async (req, res) => {
  const inv = await resetInvestorIndex(req.params.id, Number(req.body?.targetPercent) || 0);
  if (!inv) throw new HttpError(404, 'Investor not found.');
  await audit(actorOf(req), 'Investor Performance Reset', `Reset performance index for ${inv.name} to target ${req.body?.targetPercent || 0}%.`, 'MARKET');
  res.json({ investor: inv, investors: listInvestors(true) });
}));

adminRouter.get('/copies', requireAdmin(), wrap(async (_req, res) => {
  res.json(listAllCopies());
}));

adminRouter.post('/copies', requireAdmin('balance'), wrap(async (req, res) => {
  const { userId, investorId, amount, stopLossPercent, copyOpenTrades, autoCredit } = req.body || {};
  if (!userId || !investorId || !amount) throw new HttpError(400, 'User, Investor, and allocation amount are required.');
  const copy = await adminStartCopy(actorOf(req), {
    userId: String(userId),
    investorId: String(investorId),
    amount: Number(amount),
    stopLossPercent: stopLossPercent !== undefined ? Number(stopLossPercent) : 60,
    copyOpenTrades: copyOpenTrades !== false,
    autoCredit: !!autoCredit,
  });
  res.json({ copy, state: adminState(), copies: listAllCopies() });
}));

adminRouter.post('/copies/:id/adjust', requireAdmin('balance'), wrap(async (req, res) => {
  const { profitPercent, amount } = req.body || {};
  const c = await adjustCopy(req.params.id, { profitPercent, amount: amount === undefined ? undefined : Number(amount) });
  if (!c) throw new HttpError(404, 'Active copy not found.');
  await audit(actorOf(req), 'Copy P&L Adjusted', `${c.name} copy for ${c.userId}: now ${c.profitPercent}% (${c.currentValue}).`, 'MARKET', c.userId);
  res.json({ copy: c, state: adminState(), copies: listAllCopies() });
}));

adminRouter.post('/copies/:id/stop', requireAdmin('balance'), wrap(async (req, res) => {
  await stopCopy(null, req.params.id, { actor: actorOf(req), reason: String(req.body?.reason || 'closed by our trading desk') });
  res.json({ state: adminState(), copies: listAllCopies() });
}));

// ---------- Database & Git Backup Management ----------
adminRouter.get('/database/status', requireAdmin(), wrap(async (_req, res) => {
  res.json(db.getStats());
}));

adminRouter.get('/database/backup', requireAdmin(), wrap(async (_req, res) => {
  const snapshot = db.exportSnapshot();
  const dateStr = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="db-backup-${config.brand.appName.toLowerCase()}-${dateStr}.json"`);
  res.send(JSON.stringify(snapshot, null, 2));
}));

adminRouter.post('/database/restore', requireAdmin('users.delete'), wrap(async (req, res) => {
  const payload = req.body;
  if (!payload) throw new HttpError(400, 'Database snapshot JSON payload is required.');
  const result = await db.importSnapshot(payload);
  await audit(actorOf(req), 'Database Restored', `Restored database from snapshot (${result.count} documents loaded).`, 'COMPLIANCE');
  res.json({ ok: true, count: result.count, stats: db.getStats(), state: adminState() });
}));

adminRouter.post('/database/sync-git', requireAdmin(), wrap(async (req, res) => {
  db.syncGitBackupNow();
  await audit(actorOf(req), 'Git Backup Synced', `Database snapshot synced to Git repository file (${config.gitBackupPath}).`, 'COMPLIANCE');
  res.json({ ok: true, message: 'Database state successfully saved to Git backup file.', stats: db.getStats() });
}));

// Sign a client out of every device (revokes all sessions)
adminRouter.post('/users/:id/revoke-sessions', requireAdmin('users.write'), wrap(async (req, res) => {
  const u = mustUser(req.params.id);
  await db.update('users', u.id, { sessionVersion: (u.sessionVersion || 0) + 1 });
  await audit(actorOf(req), 'Sessions Revoked', `Signed ${u.name} out of all devices.`, 'USER_MGMT', `${u.id} (${u.name})`);
  res.json({ ok: true });
}));

// ---------- Users ----------
adminRouter.post('/users', requireAdmin('users.write'), wrap(async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  if (!String(b.name || '').trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, 'Name and a valid email are required.');
  if (findUserByEmail(email)) throw new HttpError(409, 'A user with this email already exists.');

  const user: any = baseUserRecord({ name: b.name, email, phone: b.phone, country: b.country });
  Object.assign(user, {
    tier: b.tier || user.tier,
    currency: b.currency || 'USD',
    realBalance: 0,
    virtualBalance: Number(b.virtualBalance) || config.practiceBalance,
    kycStatus: b.kycStatus === 'Approved' ? 'Approved' : 'Pending',
    kycDocType: b.kycDocType || 'Passport',
    kycDocNumber: b.kycDocNumber || '',
    kycSubmittedDate: b.kycSubmittedDate || '',
    kycNotes: b.kycStatus === 'Approved' ? '' : 'Provisioned by back office - documents pending.',
    role: b.role || 'Trader',
    leverage: Number(b.leverage) || 30,
    allowTrading: b.allowTrading !== false,
    allowShorting: !!b.allowShorting,
    allowCrypto: b.allowCrypto !== false,
    maxPositionLimit: Number(b.maxPositionLimit) || 50000,
    accountManager: b.accountManager || config.brand.defaultAccountManager,
    lastIp: 'Admin Provisioned',
    emailVerified: true,
  });
  user.referralCode = user.id;
  await db.put('users', user);
  await audit(actorOf(req), 'User Provisioning', `Created account for ${user.name} (${user.email}) - ${user.tier}, leverage 1:${user.leverage}.`, 'USER_MGMT', `${user.id} (${user.name})`);

  const initial = Number(b.realBalance) || 0;
  if (initial > 0) await manualAdjustment(user.id, initial, 'Admin Credit', 'Initial account funding upon administrative setup.', actorOf(req), false);

  // Invite email with a secure link to set their password
  const token = await createToken('setup', user.id, 72);
  await createMessage({
    userId: user.id,
    category: 'ACCOUNT',
    direction: 'outbound',
    priority: 'High',
    subject: `Your ${config.brand.appName} account is ready - set your password`,
    body: `Dear ${user.name},\n\nAn account has been opened for you at ${config.brand.appName}.\n\nAccount ID: ${user.id}\nTier: ${user.tier}\nAccount manager: ${user.accountManager}${initial > 0 ? `\nOpening balance: $${initial.toLocaleString()}` : ''}\n\nPlease use the secure link below to choose your password. The link expires in 72 hours - if it expires, use "Forgot password" on the login screen.\n\n${config.brand.appName} Client Services`,
    cta: { label: 'Set my password', url: `${config.appUrl}/reset-password?token=${token}&setup=1` },
  });
  res.json({ user: publicUser(db.get('users', user.id)), state: adminState() });
}));

const EDITABLE = ['name', 'phone', 'country', 'tier', 'currency', 'role', 'leverage', 'allowTrading', 'allowShorting', 'allowCrypto',
  'maxPositionLimit', 'accountManager', 'status', 'amlRisk', 'pepWatchlistHit', 'kycDocType', 'kycDocNumber', 'kycNotes',
  'streetAddress', 'city', 'postalCode', 'dateOfBirth', 'virtualBalance'];

adminRouter.patch('/users/:id', requireAdmin(), wrap(async (req, res) => {
  const u = mustUser(req.params.id);
  const role = (req.admin as AdminRecord).role;
  const patch: any = {};
  for (const k of EDITABLE) if (k in (req.body || {})) patch[k] = req.body[k];
  if (role !== 'Super-Admin') {
    // compliance may change status / AML / KYC notes only
    const allowed = role === 'Compliance Officer' ? ['status', 'amlRisk', 'pepWatchlistHit', 'kycNotes', 'allowTrading'] : [];
    for (const k of Object.keys(patch)) if (!allowed.includes(k)) delete patch[k];
    if (!Object.keys(patch).length) throw new HttpError(403, `Your role (${role}) cannot change these fields.`);
  }
  if ('leverage' in patch) patch.leverage = Number(patch.leverage) || u.leverage;
  if ('maxPositionLimit' in patch) patch.maxPositionLimit = Number(patch.maxPositionLimit) || u.maxPositionLimit;
  await db.update('users', u.id, patch);

  const labels: string[] = [];
  for (const [k, v] of Object.entries(patch)) labels.push(`${k}=${typeof v === 'boolean' ? (v ? 'ENABLED' : 'RESTRICTED') : v}`);
  const actionName = 'status' in patch ? 'Status Change' : 'tier' in patch ? 'Tier Change' : 'leverage' in patch ? 'Margin & Leverage'
    : 'amlRisk' in patch ? 'AML Risk Rating' : ['allowTrading', 'allowShorting', 'allowCrypto'].some(k => k in patch) ? 'Trading Permissions' : 'Account Update';
  await audit(actorOf(req), actionName, `${labels.join(', ')}${req.body?.reason ? ` - Reason: ${req.body.reason}` : ''}`,
    actionName === 'AML Risk Rating' ? 'COMPLIANCE' : 'USER_MGMT', `${u.id} (${u.name})`);

  // Notify clients about changes that affect them
  if ('status' in patch && patch.status !== u.status) {
    await createMessage({
      userId: u.id, category: 'ACCOUNT', direction: 'outbound', priority: patch.status === 'Active' ? 'Normal' : 'Urgent',
      subject: patch.status === 'Active' ? 'Your account has been reactivated' : `Account status update: ${patch.status}`,
      body: patch.status === 'Active'
        ? `Dear ${u.name},\n\nYour account is active again and full access has been restored.\n\n${config.brand.appName} Client Services`
        : `Dear ${u.name},\n\nThe status of your account has been changed to "${patch.status}".${req.body?.reason && req.body.reason !== 'Admin override' ? `\n\nReason: ${req.body.reason}` : ''}\n\nPlease contact ${config.brand.complianceEmail} for more information.\n\n${config.brand.appName} Compliance Desk`,
    });
  }
  if ('tier' in patch && patch.tier !== u.tier) {
    await createMessage({
      userId: u.id, category: 'ACCOUNT', direction: 'outbound',
      subject: `Your account tier is now ${patch.tier}`,
      body: `Dear ${u.name},\n\nYour account has been moved to ${patch.tier}.\n\n${config.brand.appName} Client Services`,
    });
  }
  if ('leverage' in patch && patch.leverage !== u.leverage) {
    await createMessage({
      userId: u.id, category: 'TRADING', direction: 'outbound',
      subject: `Leverage updated to 1:${patch.leverage}`,
      body: `Dear ${u.name},\n\nYour maximum account leverage has been set to 1:${patch.leverage}. Higher leverage increases both potential gains and losses.\n\n${config.brand.appName} Risk Desk`,
    });
  }
  res.json({ user: publicUser(db.get('users', u.id)), state: adminState() });
}));

adminRouter.post('/users/:id/impersonate', requireAdmin('users.write'), wrap(async (req, res) => {
  const u = mustUser(req.params.id);
  issueUserSession(res, u.id, false);
  await audit(actorOf(req), 'Impersonation', `Opened client portal session as ${u.name} for support purposes.`, 'USER_MGMT', `${u.id} (${u.name})`);
  res.json({ user: publicUser(u) });
}));

adminRouter.post('/users/:id/password-reset', requireAdmin(), wrap(async (req, res) => {
  const u = mustUser(req.params.id);
  const token = await createToken('reset', u.id, 24);
  await createMessage({
    userId: u.id, category: 'ACCOUNT', direction: 'outbound', priority: 'High',
    subject: `Reset your ${config.brand.appName} password`,
    body: `Dear ${u.name},\n\nOur client services team has issued a password reset link for your account. It expires in 24 hours.\n\nIf you did not request this, please contact ${config.brand.supportEmail}.`,
    cta: { label: 'Choose a new password', url: `${config.appUrl}/reset-password?token=${token}` },
  });
  await audit(actorOf(req), 'Password Reset Issued', `Password reset link emailed to ${u.email}.`, 'USER_MGMT', `${u.id} (${u.name})`);
  res.json({ ok: true });
}));

adminRouter.delete('/users/:id', requireAdmin('users.delete'), wrap(async (req, res) => {
  const u = mustUser(req.params.id);
  for (const coll of ['positions', 'copies', 'tokens'] as const) {
    for (const d of db.filter<any>(coll, d => d.userId === u.id)) await db.remove(coll, d.id);
  }
  await db.remove('users', u.id);
  await audit(actorOf(req), 'Account Deleted', `Deleted account ${u.name} (${u.email}). Ledger records retained.`, 'USER_MGMT', `${u.id} (${u.name})`);
  res.json({ state: adminState() });
}));

// ---------- KYC ----------
adminRouter.post('/users/:id/kyc/approve', requireAdmin('kyc'), wrap(async (req, res) => {
  await approveKyc(req.params.id, actorOf(req), req.body?.tier);
  res.json({ state: adminState() });
}));
adminRouter.post('/users/:id/kyc/reject', requireAdmin('kyc'), wrap(async (req, res) => {
  await rejectKyc(req.params.id, String(req.body?.reason || 'Documents could not be verified.'), actorOf(req));
  res.json({ state: adminState() });
}));
adminRouter.post('/users/:id/kyc/resubmit', requireAdmin('kyc'), wrap(async (req, res) => {
  await requestKycResubmit(req.params.id, String(req.body?.note || 'Please upload a clearer copy of your documents.'), actorOf(req));
  res.json({ state: adminState() });
}));

adminRouter.get('/files/:id', requireAdmin(), wrap(async (req, res) => {
  const f = await db.getFile(req.params.id);
  if (!f) return res.status(404).end();
  res.setHeader('Content-Type', f.meta.mime);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.meta.filename)}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(f.data);
}));

// ---------- Funding ----------
adminRouter.post('/transactions/:id/approve', requireAdmin('funding'), wrap(async (req, res) => {
  await approveFunding(req.params.id, actorOf(req));
  res.json({ state: adminState() });
}));
adminRouter.post('/transactions/:id/reject', requireAdmin('funding'), wrap(async (req, res) => {
  await rejectFunding(req.params.id, String(req.body?.reason || 'Rejected by treasury desk.'), actorOf(req));
  res.json({ state: adminState() });
}));
adminRouter.post('/users/:id/adjust', requireAdmin('balance'), wrap(async (req, res) => {
  const { amount, type, note, notify } = req.body || {};
  if (!['Admin Credit', 'Admin Debit', 'Bonus'].includes(type)) throw new HttpError(400, 'Invalid adjustment type.');
  await manualAdjustment(req.params.id, Number(amount), type, String(note || 'Administrative adjustment'), actorOf(req), notify !== false);
  res.json({ state: adminState() });
}));

// ---------- Positions ----------
adminRouter.post('/positions/:id/close', requireAdmin('users.write'), wrap(async (req, res) => {
  await closePosition(req.params.id, { name: actorOf(req), isAdmin: true });
  res.json({ state: adminState() });
}));

// ---------- Messages ----------
adminRouter.post('/messages', requireAdmin('emails'), wrap(async (req, res) => {
  const { userId, subject, body, category, priority, toEmail, replyToId } = req.body || {};
  if (!String(subject || '').trim() || !String(body || '').trim()) throw new HttpError(400, 'Subject and body are required.');
  let target = String(userId || 'ALL');
  let guestEmail = toEmail as string | undefined;
  let customRecipientName = req.body?.userName as string | undefined;

  if (target === 'CUSTOM') {
    const rawTo = String(toEmail || req.body?.to || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(rawTo)) {
      throw new HttpError(400, 'Enter a valid recipient email address.');
    }
    guestEmail = rawTo;
  } else if (replyToId) {
    const orig = db.get<any>('emails', replyToId);
    if (orig) {
      await markMessageRead(orig.id);
      if (!db.get('users', orig.userId)) { target = 'GUEST'; guestEmail = orig.replyEmail; }
      else target = orig.userId;
    }
  }

  if (target !== 'ALL' && target !== 'GUEST' && target !== 'CUSTOM') mustUser(target);
  if (target === 'GUEST' && !guestEmail) throw new HttpError(400, 'No recipient email for this guest message.');

  const recipientDisplayName = target === 'CUSTOM'
    ? (customRecipientName || guestEmail)
    : target === 'GUEST'
    ? (db.get<any>('emails', replyToId)?.userName || 'Guest')
    : undefined;

  const msg = await createMessage({
    userId: target,
    toEmail: guestEmail,
    subject: String(subject),
    body: String(body),
    category: (category || 'SUPPORT') as Category,
    priority: priority || 'Normal',
    direction: 'outbound',
    userName: recipientDisplayName,
  });
  await audit(actorOf(req), 'Email Sent', `Sent [${msg.category}] "${msg.subject}" to ${msg.userName} (${msg.to}).`, 'COMPLIANCE', msg.userName);
  res.json({ message: msg, state: adminState() });
}));

adminRouter.post('/messages/:id/read', requireAdmin(), wrap(async (req, res) => {
  await markMessageRead(req.params.id);
  res.json({ ok: true });
}));

adminRouter.delete('/messages/:id', requireAdmin('emails'), wrap(async (req, res) => {
  await db.remove('emails', req.params.id);
  res.json({ state: adminState() });
}));

// ---------- Markets ----------
adminRouter.post('/markets/:symbol/halt', requireAdmin('users.write'), wrap(async (req, res) => {
  await setAssetHalt(decodeURIComponent(req.params.symbol), !!req.body?.halted, actorOf(req));
  res.json({ state: adminState() });
}));

// ---------- Settings ----------
adminRouter.put('/settings/payments', requireAdmin('funding'), wrap(async (req, res) => {
  const payments = await savePaymentSettings(req.body || {}, actorOf(req));
  res.json({ payments, state: adminState() });
}));

// ---------- Audit export ----------
adminRouter.get('/audit.csv', requireAdmin('audit'), (_req, res) => {
  const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = db.all<any>('auditLogs').sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const csv = ['timestamp,admin,action,type,target,details', ...rows.map(r => [r.timestamp, r.adminUser, r.action, r.type, r.targetUser, r.details].map(esc).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

adminRouter.get('/users.csv', requireAdmin(), (_req, res) => {
  const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const cols = ['id', 'name', 'email', 'phone', 'country', 'tier', 'status', 'kycStatus', 'realBalance', 'joinedDate'];
  const csv = [cols.join(','), ...db.all<any>('users').map(u => cols.map(c => esc(u[c])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="clients-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});
