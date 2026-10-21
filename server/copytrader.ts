import { db, newId, nowStamp } from './db';
import { POPULAR_INVESTORS } from '../src/data/mockData';

/**
 * CopyTrader engine.
 * Popular Investors live in the database (admin-editable). Each investor has a live performance
 * index that moves every few seconds (drift from their target return + volatility from risk score).
 * A copy portfolio's value = allocation x (index now / index when the copy started) + any admin adjustment,
 * so every copier's P&L moves in step with the investor they follow.
 */

export interface InvestorRecord {
  id: string;
  name: string;
  handle: string;
  avatarUrl: string;
  role: string;
  bio: string;
  return24M: number;
  baseCopiers: number;
  riskScore: number;
  topHoldings: string[];
  dailyTarget?: number | null; // optional override, % per day (e.g. 0.5 = +0.5%/day)
  active: boolean;
  perfIndex: number;
  sortOrder?: number;
  createdAt?: string;
}

const TICK_MS = 10000;
const index = new Map<string, number>();
let persistCounter = 0;

export async function seedInvestors() {
  if (db.all('investors').length === 0) {
    let order = 0;
    for (const i of POPULAR_INVESTORS) {
      await db.put<InvestorRecord>('investors', {
        id: String(i.id), name: i.name, handle: i.handle, avatarUrl: i.avatarUrl, role: i.role, bio: i.bio,
        return24M: i.return24M, baseCopiers: i.copiers, riskScore: i.riskScore, topHoldings: i.topHoldings,
        dailyTarget: null, active: true, perfIndex: 1, sortOrder: order++, createdAt: new Date().toISOString(),
      });
    }
    console.log(`[copytrader] seeded ${POPULAR_INVESTORS.length} popular investors`);
  }
  for (const inv of db.all<InvestorRecord>('investors')) index.set(inv.id, inv.perfIndex || 1);
  await migrateLegacyCopies();
}

export const investorIndex = (id: string) => index.get(String(id)) ?? 1;
export const getInvestorRecord = (id: string) => db.get<InvestorRecord>('investors', String(id));

const activeCopyCount = (investorId: string) =>
  db.filter<any>('copies', c => String(c.investorId) === String(investorId) && c.status === 'Active').length;

/** Public shape used by the website (matches the frontend PopularInvestor type). */
export function publicInvestor(inv: InvestorRecord) {
  const idx = investorIndex(inv.id);
  return {
    id: inv.id,
    name: inv.name,
    handle: inv.handle,
    avatarUrl: inv.avatarUrl,
    role: inv.role,
    bio: inv.bio,
    return24M: inv.return24M,
    copiers: (inv.baseCopiers || 0) + activeCopyCount(inv.id),
    riskScore: inv.riskScore,
    topHoldings: inv.topHoldings || [],
    liveChangePercent: Number(((idx - 1) * 100).toFixed(2)),
  };
}

export function listInvestors(includeHidden = false) {
  return db
    .filter<InvestorRecord>('investors', i => includeHidden || i.active !== false)
    .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999) || b.return24M - a.return24M)
    .map(i => (includeHidden ? { ...publicInvestor(i), active: i.active !== false, baseCopiers: i.baseCopiers, dailyTarget: i.dailyTarget ?? null, activeCopies: activeCopyCount(i.id), sortOrder: i.sortOrder ?? 0 } : publicInvestor(i)));
}

// ---------- Live engine ----------
export function startCopyEngine(onStopLoss: (copy: any) => Promise<void>) {
  const dtDays = TICK_MS / 86400000;
  setInterval(() => {
    for (const inv of db.all<InvestorRecord>('investors')) {
      const cur = index.get(inv.id) ?? inv.perfIndex ?? 1;
      const dailyDrift = (inv.dailyTarget ?? null) !== null && inv.dailyTarget !== undefined
        ? Number(inv.dailyTarget) / 100
        : (Number(inv.return24M) || 0) / 100 / 730;
      const dailyVol = Math.max(1, Math.min(10, Number(inv.riskScore) || 4)) * 0.004; // 0.4% per risk point per day
      const shock = (Math.random() * 2 - 1) * Math.sqrt(3) * dailyVol * Math.sqrt(dtDays); // uniform with matching std-dev
      const next = Math.max(0.05, cur * (1 + dailyDrift * dtDays + shock));
      index.set(inv.id, next);
    }
    if (++persistCounter % 30 === 0) persistIndexes().catch(e => console.error('[copytrader] persist failed', e));
    if (persistCounter % 6 === 0) checkStopLosses(onStopLoss).catch(e => console.error('[copytrader] stop-loss check failed', e));
  }, TICK_MS);
}

export async function persistIndexes() {
  for (const [id, v] of index) {
    const inv = getInvestorRecord(id);
    if (inv && Math.abs((inv.perfIndex || 1) - v) > 1e-9) await db.update('investors', id, { perfIndex: v });
  }
}

async function checkStopLosses(onStopLoss: (copy: any) => Promise<void>) {
  for (const c of db.filter<any>('copies', c => c.status === 'Active')) {
    const v = valueCopy(c);
    const sl = Number(c.stopLossPercent) || 0;
    if (sl > 0 && sl < 100 && v.currentValue <= c.allocated * (1 - sl / 100)) await onStopLoss(c);
  }
}

// ---------- Valuation ----------
export function valueCopy(c: any) {
  const idx = investorIndex(c.investorId);
  const start = Number(c.startIndex) || idx;
  const adjustment = Number(c.adjustment) || 0;
  const currentValue = Number(Math.max(0, c.allocated * (idx / start) + adjustment).toFixed(2));
  const profit = Number((currentValue - c.allocated).toFixed(2));
  return {
    ...c,
    currentValue,
    profit,
    profitPercent: c.allocated ? Number(((profit / c.allocated) * 100).toFixed(2)) : 0,
  };
}

/** Copies created before the live engine get a startIndex that preserves their current value. */
async function migrateLegacyCopies() {
  for (const c of db.filter<any>('copies', c => c.status === 'Active' && !c.startIndex)) {
    const inv = getInvestorRecord(c.investorId);
    const days = Math.max(0, (Date.now() - (c.startedTs || Date.now())) / 86400000);
    const legacyGrowth = inv ? days * (inv.return24M / 100 / 730) : 0;
    const idx = investorIndex(c.investorId);
    await db.update('copies', c.id, { startIndex: idx / (1 + legacyGrowth) });
  }
}

// ---------- Admin management ----------
const clean = (b: any) => {
  const out: Partial<InvestorRecord> = {};
  if (b.name !== undefined) out.name = String(b.name).trim();
  if (b.handle !== undefined) { const h = String(b.handle).trim(); out.handle = h.startsWith('@') ? h : `@${h}`; }
  if (b.avatarUrl !== undefined) {
    const v = String(b.avatarUrl).trim();
    const isData = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v);
    const isUrl = /^https?:\/\/\S+$/.test(v);
    if (v && !isData && !isUrl) throw new Error('Photo must be an uploaded image or an https:// link.');
    if (isData && v.length > 600_000) throw new Error('Photo is too large - please use a smaller image.');
    out.avatarUrl = v;
  }
  if (b.role !== undefined) out.role = String(b.role).trim();
  if (b.bio !== undefined) out.bio = String(b.bio).trim();
  if (b.return24M !== undefined) out.return24M = Number(b.return24M) || 0;
  if (b.baseCopiers !== undefined) out.baseCopiers = Math.max(0, Math.round(Number(b.baseCopiers) || 0));
  if (b.riskScore !== undefined) out.riskScore = Math.max(1, Math.min(10, Math.round(Number(b.riskScore) || 1)));
  if (b.topHoldings !== undefined) {
    out.topHoldings = (Array.isArray(b.topHoldings) ? b.topHoldings : String(b.topHoldings).split(','))
      .map((s: string) => String(s).trim().toUpperCase()).filter(Boolean).slice(0, 8);
  }
  if (b.dailyTarget !== undefined) out.dailyTarget = b.dailyTarget === '' || b.dailyTarget === null ? null : Number(b.dailyTarget);
  if (b.active !== undefined) out.active = !!b.active;
  if (b.sortOrder !== undefined) out.sortOrder = Number(b.sortOrder) || 0;
  return out;
};

export async function createInvestor(b: any) {
  const data = clean(b);
  if (!data.name) throw new Error('Name is required.');
  const rec: InvestorRecord = {
    id: newId('INV', 5),
    name: data.name,
    handle: data.handle || `@${data.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
    avatarUrl: data.avatarUrl || `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(data.name)}`,
    role: data.role || 'Popular Investor',
    bio: data.bio || '',
    return24M: data.return24M ?? 0,
    baseCopiers: data.baseCopiers ?? 0,
    riskScore: data.riskScore ?? 4,
    topHoldings: data.topHoldings || [],
    dailyTarget: data.dailyTarget ?? null,
    active: data.active ?? true,
    perfIndex: 1,
    sortOrder: data.sortOrder ?? db.all('investors').length,
    createdAt: new Date().toISOString(),
  };
  await db.put('investors', rec);
  index.set(rec.id, 1);
  return rec;
}

export async function updateInvestor(id: string, b: any) {
  const inv = getInvestorRecord(id);
  if (!inv) return null;
  const patch = clean(b);
  // Copies keep following the same investor record, so name changes propagate to their portfolios.
  await db.update('investors', id, patch);
  if (patch.name || patch.handle || patch.riskScore) {
    for (const c of db.filter<any>('copies', c => String(c.investorId) === id && c.status === 'Active')) {
      await db.update('copies', c.id, { name: patch.name ?? c.name, handle: patch.handle ?? c.handle, riskScore: patch.riskScore ?? c.riskScore });
    }
  }
  return getInvestorRecord(id);
}

export async function deleteInvestor(id: string) {
  const inv = getInvestorRecord(id);
  if (!inv) return { deleted: false, hidden: false };
  if (activeCopyCount(id) > 0) {
    await db.update('investors', id, { active: false });
    return { deleted: false, hidden: true };
  }
  await db.remove('investors', id);
  index.delete(id);
  return { deleted: true, hidden: false };
}

/** Admin P&L adjustment on a single copy: either set an exact P&L % or add/subtract a cash amount. */
export async function adjustCopy(copyId: string, input: { profitPercent?: number; amount?: number }) {
  const c = db.get<any>('copies', copyId);
  if (!c || c.status !== 'Active') return null;
  const now = valueCopy(c);
  let adjustment = Number(c.adjustment) || 0;
  if (input.profitPercent !== undefined && input.profitPercent !== null && String(input.profitPercent) !== '') {
    const target = c.allocated * (1 + Number(input.profitPercent) / 100);
    adjustment += target - now.currentValue;
  } else if (input.amount !== undefined) {
    adjustment += Number(input.amount) || 0;
  }
  await db.update('copies', copyId, { adjustment, adjustedAt: nowStamp() });
  return valueCopy(db.get('copies', copyId));
}

/** Reset an investor's performance index or set target index */
export async function resetInvestorIndex(id: string, targetPercent = 0) {
  const inv = getInvestorRecord(id);
  if (!inv) return null;
  const newIdx = Math.max(0.01, 1 + targetPercent / 100);
  index.set(id, newIdx);
  await db.update('investors', id, { perfIndex: newIdx });
  return getInvestorRecord(id);
}

/** Get both active and closed copies for admin oversight */
export function listAllCopies() {
  const all = db.all<any>('copies');
  const active = all.filter(c => c.status === 'Active').map(valueCopy);
  const closed = all.filter(c => c.status !== 'Active').map(c => {
    const userName = db.get<any>('users', c.userId)?.name || c.userId;
    const userEmail = db.get<any>('users', c.userId)?.email || '';
    const finalVal = Number(c.finalValue ?? c.allocated);
    const profit = Number((finalVal - c.allocated).toFixed(2));
    const profitPercent = c.allocated ? Number(((profit / c.allocated) * 100).toFixed(2)) : 0;
    return {
      ...c,
      userName,
      userEmail,
      currentValue: finalVal,
      profit,
      profitPercent,
    };
  }).sort((a, b) => (b.stoppedTs || b.startedTs || 0) - (a.stoppedTs || a.startedTs || 0));

  return { active, closed };
}
