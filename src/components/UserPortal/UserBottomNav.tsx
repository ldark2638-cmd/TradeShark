import React from 'react';
import { Home, LineChart, Users, Wallet, Menu } from 'lucide-react';
import type { UserTab } from './UserSidebar';

const ITEMS: { tab: UserTab | 'more'; label: string; icon: React.ReactNode }[] = [
  { tab: 'portfolio', label: 'Home', icon: <Home className="w-5 h-5" /> },
  { tab: 'markets', label: 'Markets', icon: <LineChart className="w-5 h-5" /> },
  { tab: 'copy', label: 'Copy', icon: <Users className="w-5 h-5" /> },
  { tab: 'deposit', label: 'Wallet', icon: <Wallet className="w-5 h-5" /> },
  { tab: 'more', label: 'More', icon: <Menu className="w-5 h-5" /> },
];

const WALLET_TABS: UserTab[] = ['deposit', 'withdraw', 'history'];

/** Phone-only tab bar for the client portal. "More" opens the full menu. */
export const UserBottomNav: React.FC<{
  active: UserTab;
  onSelect: (tab: UserTab) => void;
  onMore: () => void;
  badge?: number;
}> = ({ active, onSelect, onMore, badge = 0 }) => {
  const inMain = ['portfolio', 'markets', 'copy', ...WALLET_TABS].includes(active);
  return (
    <nav
      className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-[#12140c]/95 backdrop-blur border-t border-white/10 pb-[env(safe-area-inset-bottom)]"
      aria-label="Client portal"
    >
      <ul className="grid grid-cols-5">
        {ITEMS.map(it => {
          const isActive = it.tab === 'more' ? !inMain : it.tab === 'deposit' ? WALLET_TABS.includes(active) : active === it.tab;
          return (
            <li key={it.tab}>
              <button
                onClick={() => (it.tab === 'more' ? onMore() : onSelect(it.tab as UserTab))}
                aria-current={isActive ? 'page' : undefined}
                className={`relative w-full h-16 flex flex-col items-center justify-center gap-1 text-[11px] font-medium ${isActive ? 'text-[#6dff8a]' : 'text-white/55'}`}
              >
                {isActive && <span className="absolute top-0 h-0.5 w-8 rounded-full bg-[#6dff8a]" />}
                <span className="relative">
                  {it.icon}
                  {it.tab === 'more' && badge > 0 && (
                    <span className="absolute -top-1.5 -right-2 min-w-4 h-4 px-1 rounded-full bg-cyan-400 text-[#15170f] text-[10px] font-bold flex items-center justify-center">{badge}</span>
                  )}
                </span>
                {it.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
};
