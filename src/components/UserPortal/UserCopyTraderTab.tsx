import React, { useMemo, useState, useEffect } from 'react';
import { Search, Users, ShieldCheck, X, TrendingUp, TrendingDown, Info } from 'lucide-react';
import { useBrokerage, CopyPortfolio } from '../../context/BrokerageContext';
import { PopularInvestor } from '../../types';
import { errMsg } from '../../lib/api';

const usd = (n: number, d = 2) =>
  `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;

const riskTone = (r: number) =>
  r <= 3 ? { label: 'Low risk', cls: 'text-[#6dff8a] bg-[#6dff8a]/10 border-[#6dff8a]/25' }
    : r <= 6 ? { label: 'Medium risk', cls: 'text-yellow-300 bg-yellow-300/10 border-yellow-300/25' }
      : { label: 'High risk', cls: 'text-[#ff7a7a] bg-[#ff5c5c]/10 border-[#ff5c5c]/25' };

const Avatar: React.FC<{ inv?: Pick<PopularInvestor, 'name' | 'avatarUrl'>; size?: string }> = ({ inv, size = 'w-14 h-14' }) => {
  const [broken, setBroken] = useState(false);
  const initials = (inv?.name || '?').split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();
  if (!inv?.avatarUrl || broken) {
    return <div className={`${size} rounded-2xl bg-[#6dff8a]/15 text-[#6dff8a] flex items-center justify-center font-bold shrink-0`}>{initials}</div>;
  }
  return <img src={inv.avatarUrl} alt="" onError={() => setBroken(true)} className={`${size} rounded-2xl object-cover bg-white/5 shrink-0`} />;
};

const Pnl: React.FC<{ value: number; pct?: number; className?: string }> = ({ value, pct, className = '' }) => (
  <span className={`tabular-nums font-semibold ${value >= 0 ? 'text-[#6dff8a]' : 'text-[#ff7a7a]'} ${className}`}>
    {value >= 0 ? '+' : '−'}{usd(Math.abs(value))}{pct !== undefined && <span className="opacity-80"> ({pct >= 0 ? '+' : ''}{pct}%)</span>}
  </span>
);

type Sort = 'return' | 'copiers' | 'risk';

export const UserCopyTraderTab: React.FC<{ onDeposit: () => void }> = ({ onDeposit }) => {
  const { investors, copies, currentUser, startCopy, stopCopy, notify } = useBrokerage();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('return');
  const [selected, setSelected] = useState<PopularInvestor | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);

  const mine = copies.filter(c => c.userId === currentUser?.id);
  const byId = useMemo(() => new Map(investors.map(i => [String(i.id), i])), [investors]);
  const copyingIds = new Set(mine.map(c => String(c.investorId)));

  const totals = mine.reduce((a, c) => ({ allocated: a.allocated + c.allocated, value: a.value + c.currentValue }), { allocated: 0, value: 0 });
  const totalPnl = totals.value - totals.allocated;

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return investors
      .filter(i => !q || i.name.toLowerCase().includes(q) || i.handle.toLowerCase().includes(q) || (i.topHoldings || []).some(h => h.toLowerCase().includes(q)))
      .sort((a, b) => sort === 'return' ? b.return24M - a.return24M : sort === 'copiers' ? b.copiers - a.copiers : a.riskScore - b.riskScore);
  }, [investors, query, sort]);

  const stop = async (c: CopyPortfolio) => {
    if (!window.confirm(`Stop copying ${c.name}? ${usd(c.currentValue)} will return to your available balance.`)) return;
    setStopping(c.id);
    try {
      await stopCopy(c.id);
      notify(`Stopped copying ${c.name}. ${usd(c.currentValue)} returned to your balance.`);
    } catch (e) { notify(errMsg(e), 'error'); } finally { setStopping(null); }
  };

  return (
    <div className="space-y-8">
      {/* Your copies */}
      {mine.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-end justify-between gap-3">
            <h3 className="text-base font-bold text-white">Your copies</h3>
            <span className="text-xs text-white/50">Updates every few seconds</span>
          </div>

          <div className="grid grid-cols-3 gap-px rounded-2xl overflow-hidden bg-white/10 border border-white/10">
            {[
              ['Invested', <span className="tabular-nums font-semibold text-white">{usd(totals.allocated, 0)}</span>],
              ['Value now', <span className="tabular-nums font-semibold text-white">{usd(totals.value)}</span>],
              ['Profit / loss', <Pnl value={totalPnl} />],
            ].map(([label, val], i) => (
              <div key={i} className="bg-[#181b11] p-3 sm:p-4">
                <div className="text-[11px] text-white/50">{label}</div>
                <div className="text-sm sm:text-lg mt-0.5 truncate">{val}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {mine.map(c => {
              const inv = byId.get(String(c.investorId));
              return (
                <div key={c.id} className="flex items-center gap-3 p-3 sm:p-4 rounded-2xl bg-white/[0.03] border border-white/10">
                  <button onClick={() => inv && setSelected(inv)} className="shrink-0" aria-label={`View ${c.name}`}>
                    <Avatar inv={inv || { name: c.name, avatarUrl: '' }} size="w-12 h-12" />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-white truncate">{c.name}</div>
                    <div className="text-xs text-white/50 tabular-nums">{usd(c.allocated, 0)} invested · since {c.startedDate}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="tabular-nums font-bold text-white">{usd(c.currentValue)}</div>
                    <Pnl value={c.profit} pct={c.profitPercent} className="text-xs" />
                  </div>
                  <button
                    onClick={() => stop(c)}
                    disabled={stopping === c.id}
                    className="ml-1 shrink-0 h-9 px-3 rounded-xl text-xs font-semibold text-[#ff7a7a] bg-[#ff5c5c]/10 hover:bg-[#ff5c5c]/20 disabled:opacity-50"
                  >
                    {stopping === c.id ? '…' : 'Stop'}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Discover */}
      <section className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-base font-bold text-white">{mine.length ? 'Find more investors' : 'Choose an investor to copy'}</h3>
          <p className="text-sm text-white/55 max-w-xl">Your money follows their trades automatically, in proportion to what you invest. You can stop any time.</p>
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <label className="relative flex-1">
            <Search className="w-4 h-4 text-white/40 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search by name or stock"
              className="w-full h-11 pl-10 pr-3 rounded-xl bg-black/30 border border-white/10 text-sm text-white placeholder:text-white/35 focus:border-[#6dff8a]/60 focus:outline-none"
            />
          </label>
          <div className="flex gap-1 p-1 rounded-xl bg-black/30 border border-white/10 overflow-x-auto">
            {([['return', 'Top return'], ['copiers', 'Most copied'], ['risk', 'Lowest risk']] as const).map(([k, l]) => (
              <button
                key={k}
                onClick={() => setSort(k)}
                className={`h-9 px-3 rounded-lg text-xs font-semibold whitespace-nowrap ${sort === k ? 'bg-[#6dff8a] text-[#15170f]' : 'text-white/65 hover:text-white'}`}
              >{l}</button>
            ))}
          </div>
        </div>

        {investors.length === 0 ? (
          <div className="p-8 rounded-2xl border border-dashed border-white/15 text-center text-sm text-white/55">
            No investors are available to copy right now. Check back soon.
          </div>
        ) : list.length === 0 ? (
          <div className="p-8 rounded-2xl border border-dashed border-white/15 text-center text-sm text-white/55">
            Nobody matches “{query}”. <button onClick={() => setQuery('')} className="text-[#6dff8a] underline">Clear search</button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {list.map(inv => {
              const risk = riskTone(inv.riskScore);
              const copying = copyingIds.has(String(inv.id));
              return (
                <button
                  key={inv.id}
                  onClick={() => setSelected(inv)}
                  className="group text-left p-4 rounded-2xl bg-white/[0.03] border border-white/10 hover:border-[#6dff8a]/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#6dff8a] transition-colors flex flex-col gap-4"
                >
                  <div className="flex items-start gap-3">
                    <Avatar inv={inv} />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-white truncate">{inv.name}</div>
                      <div className="text-xs text-white/50 truncate">{inv.handle}</div>
                      <div className="mt-1 text-[11px] text-[#c9ffd3]/80 truncate">{inv.role}</div>
                    </div>
                    {copying && <span className="shrink-0 text-[11px] font-semibold px-2 py-1 rounded-lg bg-[#6dff8a]/15 text-[#6dff8a]">Copying</span>}
                  </div>

                  <div className="flex items-end justify-between gap-2">
                    <div>
                      <div className={`text-3xl font-extrabold tabular-nums leading-none ${inv.return24M >= 0 ? 'text-[#6dff8a]' : 'text-[#ff7a7a]'}`}>
                        {inv.return24M >= 0 ? '+' : ''}{inv.return24M}%
                      </div>
                      <div className="text-[11px] text-white/45 mt-1">return over 2 years</div>
                    </div>
                    <div className="text-right space-y-1">
                      <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-md border ${risk.cls}`}>{risk.label} {inv.riskScore}/10</span>
                      <div className="text-[11px] text-white/55 flex items-center justify-end gap-1"><Users className="w-3 h-3" />{inv.copiers.toLocaleString()} copying</div>
                    </div>
                  </div>

                  {(inv.topHoldings || []).length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {inv.topHoldings.slice(0, 4).map(h => (
                        <span key={h} className="text-[11px] px-2 py-0.5 rounded-md bg-white/5 text-white/70">{h}</span>
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </section>

      {selected && (
        <CopySheet
          investor={byId.get(String(selected.id)) || selected}
          copying={mine.find(c => String(c.investorId) === String(selected.id))}
          balance={currentUser?.realBalance || 0}
          onClose={() => setSelected(null)}
          onDeposit={() => { setSelected(null); onDeposit(); }}
          onCopy={async (amount, sl, openTrades) => {
            await startCopy(selected.id, amount, sl, openTrades);
            notify(`You're now copying ${selected.name} with ${usd(amount, 0)}.`);
            setSelected(null);
          }}
        />
      )}
    </div>
  );
};

// Bottom sheet on phones, centred dialog on larger screens.
const CopySheet: React.FC<{
  investor: PopularInvestor;
  copying?: CopyPortfolio;
  balance: number;
  onClose: () => void;
  onDeposit: () => void;
  onCopy: (amount: number, stopLoss: number, copyOpenTrades: boolean) => Promise<void>;
}> = ({ investor, copying, balance, onClose, onDeposit, onCopy }) => {
  const [amount, setAmount] = useState(Math.min(1000, Math.max(200, Math.floor(balance))));
  const [stopLoss, setStopLoss] = useState(40);
  const [openTrades, setOpenTrades] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const risk = riskTone(investor.riskScore);
  const live = investor.liveChangePercent ?? 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tooLow = amount < 200;
  const tooHigh = amount > balance;
  const maxLoss = amount * (stopLoss / 100);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try { await onCopy(amount, stopLoss, openTrades); } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm animate-fadeIn" onClick={onClose} role="dialog" aria-modal="true" aria-label={`Copy ${investor.name}`}>
      <div
        onClick={e => e.stopPropagation()}
        className="w-full sm:max-w-lg max-h-[92vh] overflow-y-auto bg-[#171a10] border-t sm:border border-white/10 rounded-t-3xl sm:rounded-3xl shadow-2xl"
      >
        <div className="sm:hidden flex justify-center pt-2.5"><span className="w-10 h-1 rounded-full bg-white/20" /></div>
        <div className="p-5 sm:p-6 space-y-5">
          <div className="flex items-start gap-4">
            <Avatar inv={investor} size="w-16 h-16" />
            <div className="min-w-0 flex-1">
              <h3 className="text-lg font-bold text-white leading-tight">{investor.name}</h3>
              <div className="text-sm text-white/50">{investor.handle}</div>
              <div className="text-xs text-[#c9ffd3]/80 mt-0.5 flex items-center gap-1"><ShieldCheck className="w-3.5 h-3.5" />{investor.role}</div>
            </div>
            <button onClick={onClose} className="p-2 -m-1 rounded-full text-white/60 hover:text-white hover:bg-white/10" aria-label="Close"><X className="w-5 h-5" /></button>
          </div>

          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="p-3 rounded-2xl bg-black/30">
              <div className={`text-lg font-extrabold tabular-nums ${investor.return24M >= 0 ? 'text-[#6dff8a]' : 'text-[#ff7a7a]'}`}>{investor.return24M >= 0 ? '+' : ''}{investor.return24M}%</div>
              <div className="text-[11px] text-white/50">2-year return</div>
            </div>
            <div className="p-3 rounded-2xl bg-black/30">
              <div className={`text-lg font-extrabold tabular-nums flex items-center justify-center gap-1 ${live >= 0 ? 'text-[#6dff8a]' : 'text-[#ff7a7a]'}`}>
                {live >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}{live >= 0 ? '+' : ''}{live}%
              </div>
              <div className="text-[11px] text-white/50">Live</div>
            </div>
            <div className="p-3 rounded-2xl bg-black/30">
              <div className="text-lg font-extrabold tabular-nums text-white">{investor.copiers.toLocaleString()}</div>
              <div className="text-[11px] text-white/50">Copying</div>
            </div>
          </div>

          {investor.bio && <p className="text-sm text-white/70 leading-relaxed">{investor.bio}</p>}

          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-md border ${risk.cls}`}>{risk.label} {investor.riskScore}/10</span>
            {(investor.topHoldings || []).map(h => <span key={h} className="text-[11px] px-2 py-0.5 rounded-md bg-white/5 text-white/70">{h}</span>)}
          </div>

          {copying ? (
            <div className="p-4 rounded-2xl bg-[#6dff8a]/10 border border-[#6dff8a]/25 text-sm text-white/80">
              You're copying {investor.name} with <strong className="text-white tabular-nums">{usd(copying.allocated, 0)}</strong>. Current value <strong className="text-white tabular-nums">{usd(copying.currentValue)}</strong> (<Pnl value={copying.profit} pct={copying.profitPercent} />). Stop it from <em>Your copies</em>.
            </div>
          ) : (
            <div className="space-y-4 pt-1">
              <div className="space-y-2">
                <div className="flex items-baseline justify-between">
                  <label htmlFor="copy-amount" className="text-sm font-semibold text-white">Amount to invest</label>
                  <span className="text-xs text-white/50 tabular-nums">Available {usd(balance)}</span>
                </div>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-white/50 text-lg">$</span>
                  <input
                    id="copy-amount"
                    type="number"
                    inputMode="decimal"
                    min={200}
                    value={Number.isFinite(amount) ? amount : ''}
                    onChange={e => setAmount(Number(e.target.value))}
                    className="w-full h-14 pl-9 pr-4 rounded-2xl bg-black/30 border border-white/15 text-2xl font-bold tabular-nums text-white focus:border-[#6dff8a] focus:outline-none"
                  />
                </div>
                <div className="flex gap-2">
                  {[200, 500, 1000, 5000].map(v => (
                    <button key={v} onClick={() => setAmount(v)} className={`flex-1 h-9 rounded-xl text-xs font-semibold tabular-nums ${amount === v ? 'bg-white text-[#15170f]' : 'bg-white/5 text-white/75 hover:bg-white/10'}`}>${v.toLocaleString()}</button>
                  ))}
                  <button onClick={() => setAmount(Math.floor(balance))} className="flex-1 h-9 rounded-xl text-xs font-semibold bg-white/5 text-white/75 hover:bg-white/10">Max</button>
                </div>
                {tooLow && <p className="text-xs text-yellow-300">The minimum is $200.</p>}
                {tooHigh && <p className="text-xs text-yellow-300">That's more than your available balance. <button onClick={onDeposit} className="underline">Deposit funds</button></p>}
              </div>

              <div className="space-y-2">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-semibold text-white">Stop copying if I lose</span>
                  <span className="text-xs text-white/50 tabular-nums">up to {usd(maxLoss, 0)}</span>
                </div>
                <div className="flex gap-2">
                  {[20, 40, 60, 80].map(v => (
                    <button key={v} onClick={() => setStopLoss(v)} className={`flex-1 h-9 rounded-xl text-xs font-semibold tabular-nums ${stopLoss === v ? 'bg-white text-[#15170f]' : 'bg-white/5 text-white/75 hover:bg-white/10'}`}>{v}%</button>
                  ))}
                </div>
              </div>

              <label className="flex items-start gap-3 p-3 rounded-2xl bg-black/20 cursor-pointer">
                <input type="checkbox" checked={openTrades} onChange={e => setOpenTrades(e.target.checked)} className="mt-0.5 w-4 h-4 accent-[#6dff8a]" />
                <span className="text-sm text-white/75">Also copy the trades {investor.name.split(' ')[0]} already has open</span>
              </label>

              {error && <div className="p-3 rounded-xl bg-[#ff5c5c]/10 border border-[#ff5c5c]/30 text-sm text-[#ffb3b3]">{error}</div>}

              <button
                onClick={submit}
                disabled={busy || tooLow || tooHigh}
                className="w-full h-13 py-3.5 rounded-2xl bg-[#6dff8a] text-[#15170f] font-bold text-base disabled:opacity-40"
              >
                {busy ? 'Starting…' : `Copy ${investor.name.split(' ')[0]} with ${usd(amount || 0, 0)}`}
              </button>
              <p className="text-[11px] text-white/40 flex items-start gap-1.5"><Info className="w-3.5 h-3.5 shrink-0 mt-px" />Past performance doesn't guarantee future results. You could lose money.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
