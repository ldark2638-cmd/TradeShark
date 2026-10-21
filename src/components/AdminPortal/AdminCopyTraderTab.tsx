import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Save, Trash2, Eye, EyeOff, Users, Pencil, X, Camera, Link2, StopCircle, Search, RotateCcw } from 'lucide-react';
import { api, errMsg } from '../../lib/api';
import { useBrokerage } from '../../context/BrokerageContext';

interface AdminInvestor {
  id: string;
  name: string;
  handle: string;
  avatarUrl: string;
  role: string;
  bio: string;
  return24M: number;
  copiers: number;
  baseCopiers: number;
  riskScore: number;
  topHoldings: string[] | string;
  dailyTarget: number | null | '';
  active: boolean;
  activeCopies: number;
  liveChangePercent: number;
  sortOrder: number;
}

interface ClosedCopy {
  id: string; userId: string; userName?: string; userEmail?: string; investorId: string; name: string;
  allocated: number; currentValue: number; profit: number; profitPercent: number; startedDate: string;
  stoppedDate?: string; stoppedTs?: number; stopReason?: string;
}

const EMPTY: Partial<AdminInvestor> = {
  name: '', handle: '', avatarUrl: '', role: 'Popular Investor', bio: '', return24M: 30, baseCopiers: 0, riskScore: 4,
  topHoldings: '', dailyTarget: '', active: true,
};

const usd = (n: number) => `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Crop to a centred square and shrink to 320px so photos stay small (~30 KB) and load fast. */
function fileToAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type)) return reject(new Error('Choose an image file (JPG, PNG or WebP).'));
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const side = Math.min(img.width, img.height);
      const size = Math.min(320, side);
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.86));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be read. Try another file.')); };
    img.src = url;
  });
}

const Avatar: React.FC<{ src?: string; name?: string; size?: string }> = ({ src, name = '?', size = 'w-12 h-12' }) => {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  const initials = name.split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase() || '?';
  return src && !broken
    ? <img src={src} alt="" onError={() => setBroken(true)} className={`${size} rounded-2xl object-cover bg-white/5 shrink-0`} />
    : <div className={`${size} rounded-2xl bg-[#6dff8a]/15 text-[#6dff8a] font-bold flex items-center justify-center shrink-0`}>{initials}</div>;
};

export const AdminCopyTraderTab: React.FC<{ onNotify: (msg: string) => void }> = ({ onNotify }) => {
  const { copies, users, refresh } = useBrokerage();
  const [investors, setInvestors] = useState<AdminInvestor[]>([]);
  const [editing, setEditing] = useState<Partial<AdminInvestor> | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [adjust, setAdjust] = useState<Record<string, string>>({});
  const [view, setView] = useState<'investors' | 'copies' | 'assign' | 'history'>('investors');
  const [closed, setClosed] = useState<ClosedCopy[]>([]);
  const [resetTarget, setResetTarget] = useState<AdminInvestor | null>(null);
  const [resetPercent, setResetPercent] = useState('0');
  const [assign, setAssign] = useState({ userId: '', investorId: '', amount: '500', stopLoss: '60', autoCredit: false });
  const [assigning, setAssigning] = useState(false);
  const [q, setQ] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [inv, cp] = await Promise.all([api.get('/api/admin/investors'), api.get('/api/admin/copies').catch(() => null)]);
      setInvestors(inv.investors);
      if (cp?.closed) setClosed(cp.closed);
    } catch (e) { onNotify(errMsg(e)); }
  }, [onNotify]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  const openEditor = (inv?: AdminInvestor) => {
    setFormError(null);
    setEditing(inv ? { ...inv, topHoldings: Array.isArray(inv.topHoldings) ? inv.topHoldings.join(', ') : inv.topHoldings, dailyTarget: inv.dailyTarget ?? '' } : { ...EMPTY });
  };

  const save = async () => {
    if (!editing) return;
    if (!String(editing.name || '').trim()) return setFormError('Enter a name.');
    setBusy(true);
    setFormError(null);
    try {
      const r = editing.id
        ? await api.put(`/api/admin/investors/${editing.id}`, editing)
        : await api.post('/api/admin/investors', editing);
      setInvestors(r.investors);
      onNotify(editing.id ? `${editing.name} updated.` : `${editing.name} added.`);
      setEditing(null);
      refresh();
    } catch (e) { setFormError(errMsg(e)); } finally { setBusy(false); }
  };

  const pickPhoto = async (f?: File) => {
    if (!f) return;
    try {
      const data = await fileToAvatar(f);
      setEditing(ed => ({ ...ed, avatarUrl: data }));
    } catch (e) { setFormError(errMsg(e)); }
  };

  const toggle = async (inv: AdminInvestor) => {
    try {
      const r = await api.put(`/api/admin/investors/${inv.id}`, { active: !inv.active });
      setInvestors(r.investors);
      onNotify(inv.active ? `${inv.name} is hidden from clients.` : `${inv.name} is visible to clients.`);
    } catch (e) { onNotify(errMsg(e)); }
  };

  const remove = async (inv: AdminInvestor) => {
    if (!window.confirm(`Remove ${inv.name}?${inv.activeCopies ? ` ${inv.activeCopies} client(s) are copying them, so they'll be hidden instead of deleted.` : ''}`)) return;
    try {
      const r = await api.del(`/api/admin/investors/${inv.id}`);
      setInvestors(r.investors);
      onNotify(r.hidden ? `${inv.name} hidden (clients are still copying).` : `${inv.name} removed.`);
    } catch (e) { onNotify(errMsg(e)); }
  };

  const applyAdjust = async (copyId: string, mode: 'percent' | 'amount') => {
    const v = adjust[copyId];
    if (v === undefined || v === '' || isNaN(Number(v))) return onNotify('Enter a number first.');
    try {
      await api.post(`/api/admin/copies/${copyId}/adjust`, mode === 'percent' ? { profitPercent: Number(v) } : { amount: Number(v) });
      setAdjust(a => ({ ...a, [copyId]: '' }));
      onNotify('Copy profit updated.');
      refresh();
    } catch (e) { onNotify(errMsg(e)); }
  };

  const forceStop = async (copyId: string, name: string, client: string) => {
    if (!window.confirm(`Close ${client}'s copy of ${name} and return the money to their balance?`)) return;
    try { await api.post(`/api/admin/copies/${copyId}/stop`, {}); onNotify('Copy closed and money returned.'); refresh(); load(); }
    catch (e) { onNotify(errMsg(e)); }
  };

  const doReset = async () => {
    if (!resetTarget) return;
    try {
      await api.post(`/api/admin/investors/${resetTarget.id}/reset-index`, { targetPercent: Number(resetPercent) || 0 });
      onNotify(`${resetTarget.name}'s live performance set to ${Number(resetPercent) || 0}%.`);
      setResetTarget(null);
      load(); refresh();
    } catch (e) { onNotify(errMsg(e)); }
  };

  const doAssign = async () => {
    if (!assign.userId || !assign.investorId || !(Number(assign.amount) > 0)) return onNotify('Choose a client, an investor and an amount.');
    setAssigning(true);
    try {
      await api.post('/api/admin/copies', {
        userId: assign.userId, investorId: assign.investorId, amount: Number(assign.amount),
        stopLossPercent: Number(assign.stopLoss) || 60, autoCredit: assign.autoCredit,
      });
      onNotify(`Copy opened for ${userName(assign.userId)}.`);
      setAssign(a => ({ ...a, userId: '', investorId: '', amount: '500' }));
      setView('copies');
      refresh(); load();
    } catch (e) { onNotify(errMsg(e)); } finally { setAssigning(false); }
  };

  const userName = (id: string) => users.find(u => u.id === id)?.name || id;
  const shown = investors.filter(i => !q.trim() || `${i.name} ${i.handle}`.toLowerCase().includes(q.trim().toLowerCase()));

  const input = 'w-full h-11 px-3 rounded-xl bg-black/30 border border-white/10 text-sm text-white placeholder:text-white/30 focus:border-[#6dff8a]/60 focus:outline-none';
  const label = 'block text-xs text-white/60 mb-1.5';

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex p-1 rounded-xl bg-black/30 border border-white/10 w-full sm:w-auto overflow-x-auto">
          {([
            ['investors', 'Investors', investors.length],
            ['copies', 'Active copies', copies.length],
            ['assign', 'Assign copy', null],
            ['history', 'History', closed.length],
          ] as const).map(([k, l, n]) => (
            <button key={k} onClick={() => setView(k)} className={`flex-1 sm:flex-none h-9 px-3 sm:px-4 rounded-lg text-sm font-semibold whitespace-nowrap ${view === k ? 'bg-[#6dff8a] text-[#15170f]' : 'text-white/65'}`}>
              {l}{n !== null && <span className="opacity-70 tabular-nums"> {n}</span>}
            </button>
          ))}
        </div>
        {view === 'investors' && (
          <button onClick={() => openEditor()} className="h-11 px-4 rounded-xl bg-[#6dff8a] text-[#15170f] text-sm font-bold flex items-center justify-center gap-2">
            <Plus className="w-4 h-4" /> Add investor
          </button>
        )}
      </div>

      {view === 'investors' && (
        <>
          <p className="text-sm text-white/55">Clients see these investors in their dashboard's CopyTrader tab. Hidden investors stay out of the list but existing copies keep running.</p>
          {investors.length > 6 && (
            <label className="relative block">
              <Search className="w-4 h-4 text-white/40 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search investors" className={`${input} pl-10`} />
            </label>
          )}

          {investors.length === 0 ? (
            <div className="p-8 rounded-2xl border border-dashed border-white/15 text-center space-y-3">
              <p className="text-sm text-white/60">No investors yet. Add the first one so clients have someone to copy.</p>
              <button onClick={() => openEditor()} className="h-10 px-4 rounded-xl bg-[#6dff8a] text-[#15170f] text-sm font-bold">Add investor</button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
              {shown.map(inv => (
                <div key={inv.id} className={`p-4 rounded-2xl border ${inv.active ? 'bg-white/[0.03] border-white/10' : 'bg-white/[0.015] border-dashed border-white/15'} space-y-3`}>
                  <div className="flex items-start gap-3">
                    <Avatar src={inv.avatarUrl} name={inv.name} size="w-14 h-14" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-white truncate">{inv.name}</span>
                        {!inv.active && <span className="text-[11px] px-1.5 py-0.5 rounded bg-yellow-400/15 text-yellow-300">Hidden</span>}
                      </div>
                      <div className="text-xs text-white/50 truncate">{inv.handle} · {inv.role}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-2 text-center">
                    {[
                      ['2-yr', `${inv.return24M >= 0 ? '+' : ''}${inv.return24M}%`, inv.return24M >= 0 ? 'text-[#6dff8a]' : 'text-[#ff7a7a]'],
                      ['Live', `${inv.liveChangePercent >= 0 ? '+' : ''}${inv.liveChangePercent}%`, inv.liveChangePercent >= 0 ? 'text-[#6dff8a]' : 'text-[#ff7a7a]'],
                      ['Risk', `${inv.riskScore}/10`, 'text-white'],
                      ['Copiers', inv.copiers.toLocaleString(), 'text-white'],
                    ].map(([l, v, c]) => (
                      <div key={l} className="py-2 rounded-xl bg-black/25">
                        <div className={`text-sm font-bold tabular-nums ${c}`}>{v}</div>
                        <div className="text-[10px] text-white/45">{l}</div>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => openEditor(inv)} className="flex-1 h-10 rounded-xl bg-white/5 hover:bg-white/10 text-sm font-semibold text-white flex items-center justify-center gap-1.5"><Pencil className="w-4 h-4" /> Edit</button>
                    <button onClick={() => { setResetTarget(inv); setResetPercent('0'); }} className="h-10 w-11 rounded-xl bg-white/5 hover:bg-white/10 text-white/80 flex items-center justify-center" title="Set live performance" aria-label="Set live performance"><RotateCcw className="w-4 h-4" /></button>
                    <button onClick={() => toggle(inv)} className="h-10 w-11 rounded-xl bg-white/5 hover:bg-white/10 text-white/80 flex items-center justify-center" title={inv.active ? 'Hide from clients' : 'Show to clients'} aria-label={inv.active ? 'Hide from clients' : 'Show to clients'}>
                      {inv.active ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                    <button onClick={() => remove(inv)} className="h-10 w-11 rounded-xl bg-[#ff5c5c]/10 hover:bg-[#ff5c5c]/20 text-[#ff7a7a] flex items-center justify-center" title="Remove" aria-label="Remove investor"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {view === 'copies' && (
        copies.length === 0 ? (
          <div className="p-8 rounded-2xl border border-dashed border-white/15 text-center text-sm text-white/55">No client is copying an investor right now.</div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {copies.map(c => {
              const inv = investors.find(i => i.id === String(c.investorId));
              const client = userName(c.userId);
              return (
                <div key={c.id} className="p-4 rounded-2xl bg-white/[0.03] border border-white/10 space-y-3">
                  <div className="flex items-center gap-3">
                    <Avatar src={inv?.avatarUrl} name={c.name} size="w-11 h-11" />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-white truncate">{client}</div>
                      <div className="text-xs text-white/50 truncate">copying {c.name} · {c.userId}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold text-white tabular-nums">{usd(c.currentValue)}</div>
                      <div className={`text-xs font-semibold tabular-nums ${c.profit >= 0 ? 'text-[#6dff8a]' : 'text-[#ff7a7a]'}`}>{c.profit >= 0 ? '+' : '−'}{usd(Math.abs(c.profit))} ({c.profitPercent}%)</div>
                    </div>
                  </div>
                  <div className="text-xs text-white/50 tabular-nums">Invested {usd(c.allocated)} · since {c.startedDate}</div>
                  <div className="flex gap-2">
                    <input
                      value={adjust[c.id] || ''}
                      onChange={e => setAdjust(a => ({ ...a, [c.id]: e.target.value }))}
                      inputMode="decimal"
                      placeholder="e.g. 12.5 or -200"
                      aria-label="Adjustment value"
                      className="flex-1 min-w-0 h-10 px-3 rounded-xl bg-black/30 border border-white/10 text-sm text-white placeholder:text-white/30"
                    />
                    <button onClick={() => applyAdjust(c.id, 'percent')} className="h-10 px-3 rounded-xl bg-white/5 hover:bg-white/10 text-xs font-semibold text-white" title="Set total profit to this %">Set %</button>
                    <button onClick={() => applyAdjust(c.id, 'amount')} className="h-10 px-3 rounded-xl bg-white/5 hover:bg-white/10 text-xs font-semibold text-white" title="Add or subtract this dollar amount">± $</button>
                    <button onClick={() => forceStop(c.id, c.name, client)} className="h-10 w-10 rounded-xl bg-[#ff5c5c]/10 hover:bg-[#ff5c5c]/20 text-[#ff7a7a] flex items-center justify-center" title="Close copy" aria-label="Close copy"><StopCircle className="w-4 h-4" /></button>
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      {view === 'assign' && (
        <div className="max-w-xl space-y-4 p-4 sm:p-5 rounded-2xl bg-white/[0.03] border border-white/10">
          <p className="text-sm text-white/60">Open a copy for a client yourself. The amount comes out of their balance, unless you tick "credit the amount first".</p>
          <div>
            <label className={label} htmlFor="as-user">Client</label>
            <select id="as-user" className={input} value={assign.userId} onChange={e => setAssign(a => ({ ...a, userId: e.target.value }))}>
              <option value="">Choose a client</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.name} · ${u.realBalance.toLocaleString()} ({u.id})</option>)}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="as-inv">Investor</label>
            <select id="as-inv" className={input} value={assign.investorId} onChange={e => setAssign(a => ({ ...a, investorId: e.target.value }))}>
              <option value="">Choose an investor</option>
              {investors.map(i => <option key={i.id} value={i.id}>{i.name} ({i.handle}){i.active ? '' : ' · hidden'}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={label} htmlFor="as-amt">Amount ($)</label><input id="as-amt" type="number" inputMode="decimal" className={input} value={assign.amount} onChange={e => setAssign(a => ({ ...a, amount: e.target.value }))} /></div>
            <div><label className={label} htmlFor="as-sl">Stop if loss reaches (%)</label><input id="as-sl" type="number" inputMode="numeric" className={input} value={assign.stopLoss} onChange={e => setAssign(a => ({ ...a, stopLoss: e.target.value }))} /></div>
          </div>
          <label className="flex items-center gap-3 p-3 rounded-xl bg-black/20 cursor-pointer">
            <input type="checkbox" checked={assign.autoCredit} onChange={e => setAssign(a => ({ ...a, autoCredit: e.target.checked }))} className="w-4 h-4 accent-[#6dff8a]" />
            <span className="text-sm text-white/80">Credit the amount to the client first</span>
          </label>
          <button onClick={doAssign} disabled={assigning} className="w-full h-11 rounded-xl bg-[#6dff8a] text-[#15170f] text-sm font-bold disabled:opacity-50">{assigning ? 'Opening…' : 'Open copy'}</button>
        </div>
      )}

      {view === 'history' && (
        closed.length === 0 ? (
          <div className="p-8 rounded-2xl border border-dashed border-white/15 text-center text-sm text-white/55">No copies have been closed yet.</div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {closed.map(c => (
              <div key={c.id} className="p-4 rounded-2xl bg-white/[0.02] border border-white/10 flex items-center gap-3">
                <Avatar src={investors.find(i => i.id === String(c.investorId))?.avatarUrl} name={c.name} size="w-11 h-11" />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-white truncate">{c.userName || userName(c.userId)}</div>
                  <div className="text-xs text-white/50 truncate">copied {c.name} · {c.startedDate}{c.stoppedTs ? ` → ${new Date(c.stoppedTs).toISOString().slice(0, 10)}` : ''}</div>
                  {c.stopReason && <div className="text-[11px] text-white/40 truncate">{c.stopReason}</div>}
                </div>
                <div className="text-right shrink-0">
                  <div className="font-bold text-white tabular-nums">{usd(c.currentValue)}</div>
                  <div className={`text-xs font-semibold tabular-nums ${c.profit >= 0 ? 'text-[#6dff8a]' : 'text-[#ff7a7a]'}`}>{c.profit >= 0 ? '+' : '−'}{usd(Math.abs(c.profit))} ({c.profitPercent}%)</div>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {resetTarget && (
        <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setResetTarget(null)}>
          <div onClick={e => e.stopPropagation()} className="w-full sm:max-w-sm bg-[#171a10] border-t sm:border border-white/10 rounded-t-3xl sm:rounded-3xl p-5 space-y-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            <h3 className="text-base font-bold text-white">Set {resetTarget.name}'s live performance</h3>
            <p className="text-sm text-white/60">Now {resetTarget.liveChangePercent >= 0 ? '+' : ''}{resetTarget.liveChangePercent}%. Every client copying them moves with this number.</p>
            <div><label className={label} htmlFor="rs-pct">New live performance (%)</label><input id="rs-pct" type="number" step="any" inputMode="decimal" className={input} value={resetPercent} onChange={e => setResetPercent(e.target.value)} /></div>
            <div className="flex gap-2">
              <button onClick={() => setResetTarget(null)} className="flex-1 h-11 rounded-xl bg-white/5 text-sm font-semibold text-white">Cancel</button>
              <button onClick={doReset} className="flex-1 h-11 rounded-xl bg-[#6dff8a] text-[#15170f] text-sm font-bold">Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Editor: bottom sheet on phones, dialog on desktop */}
      {editing && (
        <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm animate-fadeIn" onClick={() => !busy && setEditing(null)}>
          <div onClick={e => e.stopPropagation()} className="w-full sm:max-w-2xl max-h-[94vh] overflow-y-auto bg-[#171a10] border-t sm:border border-white/10 rounded-t-3xl sm:rounded-3xl shadow-2xl">
            <div className="sticky top-0 z-10 bg-[#171a10] px-5 py-4 border-b border-white/10 flex items-center justify-between">
              <h3 className="text-base font-bold text-white">{editing.id ? `Edit ${editing.name}` : 'Add investor'}</h3>
              <button onClick={() => setEditing(null)} className="p-2 -m-2 rounded-full text-white/60 hover:text-white hover:bg-white/10" aria-label="Close"><X className="w-5 h-5" /></button>
            </div>

            <div className="p-5 space-y-5">
              <div className="flex items-center gap-4">
                <Avatar src={editing.avatarUrl} name={editing.name || '?'} size="w-20 h-20" />
                <div className="flex-1 space-y-2">
                  <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={e => { pickPhoto(e.target.files?.[0]); e.target.value = ''; }} />
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => fileRef.current?.click()} className="h-10 px-4 rounded-xl bg-white text-[#15170f] text-sm font-semibold flex items-center gap-2"><Camera className="w-4 h-4" /> {editing.avatarUrl ? 'Change photo' : 'Upload photo'}</button>
                    {editing.avatarUrl && <button onClick={() => setEditing(ed => ({ ...ed, avatarUrl: '' }))} className="h-10 px-3 rounded-xl bg-white/5 text-sm text-white/75">Remove</button>}
                  </div>
                  <p className="text-[11px] text-white/45">Square crop, resized automatically.</p>
                </div>
              </div>

              <details className="group">
                <summary className="text-xs text-white/55 cursor-pointer flex items-center gap-1.5 select-none"><Link2 className="w-3.5 h-3.5" /> Or paste a photo link</summary>
                <input
                  value={String(editing.avatarUrl || '').startsWith('data:') ? '' : editing.avatarUrl || ''}
                  onChange={e => setEditing(ed => ({ ...ed, avatarUrl: e.target.value }))}
                  placeholder="https://…"
                  className={`${input} mt-2`}
                />
              </details>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div><label className={label} htmlFor="inv-name">Name</label><input id="inv-name" className={input} value={editing.name || ''} onChange={e => setEditing(ed => ({ ...ed, name: e.target.value }))} /></div>
                <div><label className={label} htmlFor="inv-handle">Handle</label><input id="inv-handle" className={input} placeholder="@handle" value={editing.handle || ''} onChange={e => setEditing(ed => ({ ...ed, handle: e.target.value }))} /></div>
                <div className="sm:col-span-2"><label className={label} htmlFor="inv-role">Title shown under the name</label><input id="inv-role" className={input} placeholder="Elite Pro Investor" value={editing.role || ''} onChange={e => setEditing(ed => ({ ...ed, role: e.target.value }))} /></div>
              </div>

              <div>
                <label className={label} htmlFor="inv-bio">Bio</label>
                <textarea id="inv-bio" rows={3} value={editing.bio || ''} onChange={e => setEditing(ed => ({ ...ed, bio: e.target.value }))} className="w-full px-3 py-2.5 rounded-xl bg-black/30 border border-white/10 text-sm text-white focus:border-[#6dff8a]/60 focus:outline-none" />
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div><label className={label} htmlFor="inv-ret">2-year return %</label><input id="inv-ret" type="number" step="any" inputMode="decimal" className={input} value={editing.return24M ?? ''} onChange={e => setEditing(ed => ({ ...ed, return24M: e.target.value as any }))} /></div>
                <div><label className={label} htmlFor="inv-risk">Risk (1–10)</label><input id="inv-risk" type="number" min={1} max={10} inputMode="numeric" className={input} value={editing.riskScore ?? ''} onChange={e => setEditing(ed => ({ ...ed, riskScore: e.target.value as any }))} /></div>
                <div><label className={label} htmlFor="inv-cop">Base copiers</label><input id="inv-cop" type="number" min={0} inputMode="numeric" className={input} value={editing.baseCopiers ?? ''} onChange={e => setEditing(ed => ({ ...ed, baseCopiers: e.target.value as any }))} /></div>
                <div><label className={label} htmlFor="inv-daily">Daily move %</label><input id="inv-daily" type="number" step="any" inputMode="decimal" placeholder="Auto" className={input} value={editing.dailyTarget ?? ''} onChange={e => setEditing(ed => ({ ...ed, dailyTarget: e.target.value as any }))} /></div>
              </div>
              <p className="text-[11px] text-white/45 -mt-2">Copiers shown = base copiers + real client copies. Daily move sets how fast copies grow (e.g. 0.4 = +0.4% a day); leave blank to follow the 2-year return.</p>

              <div><label className={label} htmlFor="inv-hold">Top holdings</label><input id="inv-hold" className={input} placeholder="AAPL, MSFT, BTC" value={String(editing.topHoldings || '')} onChange={e => setEditing(ed => ({ ...ed, topHoldings: e.target.value }))} /></div>

              <label className="flex items-center gap-3 p-3 rounded-xl bg-black/20 cursor-pointer">
                <input type="checkbox" checked={editing.active !== false} onChange={e => setEditing(ed => ({ ...ed, active: e.target.checked }))} className="w-4 h-4 accent-[#6dff8a]" />
                <span className="text-sm text-white/80">Show to clients</span>
              </label>

              {formError && <div className="p-3 rounded-xl bg-[#ff5c5c]/10 border border-[#ff5c5c]/30 text-sm text-[#ffb3b3]">{formError}</div>}
            </div>

            <div className="sticky bottom-0 bg-[#171a10] px-5 py-4 border-t border-white/10 flex gap-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
              <button onClick={() => setEditing(null)} className="flex-1 sm:flex-none h-11 px-5 rounded-xl bg-white/5 text-sm font-semibold text-white">Cancel</button>
              <button onClick={save} disabled={busy} className="flex-1 h-11 px-5 rounded-xl bg-[#6dff8a] text-[#15170f] text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-50">
                <Save className="w-4 h-4" /> {busy ? 'Saving…' : editing.id ? 'Save changes' : 'Add investor'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
