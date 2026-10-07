import { Bell, History as HistoryIcon, LogOut, Monitor, Moon, Settings, Sun, Tv } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { formatDateTime } from '../lib/format';
import { useAuth, useLogout, useStatus } from '../lib/queries';
import { useServer } from '../lib/server';
import { applyTheme, storedTheme, type ThemeChoice } from '../lib/theme';
import { Banner } from './ui/Feedback';
import { StatusChip } from './ui/StatusChip';

const NAV = [
  { to: '/', label: 'Live', icon: Tv, end: true },
  { to: '/history', label: 'History', icon: HistoryIcon, end: false },
  { to: '/alerts', label: 'Alerts', icon: Bell, end: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false },
];

const THEMES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'Theme: system', icon: Monitor },
  { value: 'light', label: 'Theme: light', icon: Sun },
  { value: 'dark', label: 'Theme: dark', icon: Moon },
];

function ThemeButton() {
  const [theme, setTheme] = useState<ThemeChoice>(storedTheme);
  const i = THEMES.findIndex((t) => t.value === theme);
  const current = THEMES[i] ?? THEMES[0];
  const next = THEMES[(i + 1) % THEMES.length] ?? THEMES[0];
  if (!current || !next) return null;
  const Icon = current.icon;
  return (
    <button
      type="button"
      title={`${current.label} (switch to ${next.value})`}
      aria-label={`${current.label}. Switch to ${next.value}`}
      onClick={() => {
        applyTheme(next.value);
        setTheme(next.value);
      }}
      className="rounded-md p-2 text-ink-2 hover:bg-surface-2 hover:text-ink"
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}

function TvhStatus() {
  const status = useStatus();
  const { tz } = useServer();
  const tvh = status.data?.tvh;
  if (!tvh) return null;
  if (!tvh.configured) return <StatusChip tone="neutral">TVHeadend not set up</StatusChip>;
  if (tvh.connected) {
    return (
      <StatusChip tone="good" title={tvh.version ? `TVHeadend ${tvh.version}` : undefined}>
        TVHeadend
      </StatusChip>
    );
  }
  return (
    <StatusChip tone="critical" title={tvh.error ?? undefined}>
      TVHeadend down{tvh.downSince ? ` since ${formatDateTime(tvh.downSince, tz)}` : ''}
    </StatusChip>
  );
}

function GlobalBanners() {
  const status = useStatus();
  const { tz } = useServer();
  const tvh = status.data?.tvh;
  if (!tvh) return null;
  if (!tvh.configured) {
    return (
      <Banner tone="warning">
        tvspy is not connected to TVHeadend yet.{' '}
        <Link to="/settings" className="font-medium text-accent-ink underline">
          Enter its address and an admin account
        </Link>
        .
      </Banner>
    );
  }
  if (!tvh.connected) {
    return (
      <Banner tone="critical">
        <strong className="font-semibold">TVHeadend is not answering</strong>
        {tvh.downSince ? ` since ${formatDateTime(tvh.downSince, tz)}` : ''}. {tvh.error}
        {tvh.lastOkAt && (
          <span className="text-ink-2">
            {' '}
            Last data: {formatDateTime(tvh.lastOkAt, tz)}. Live data below may be stale.
          </span>
        )}
      </Banner>
    );
  }
  return null;
}

export function Layout() {
  const auth = useAuth();
  const logout = useLogout();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold text-ink">
            <Tv className="size-5 text-accent" aria-hidden />
            tvspy
          </Link>
          <nav aria-label="Main" className="ml-2 hidden items-center gap-1 md:flex">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm ${
                    isActive
                      ? 'bg-accent-wash font-medium text-accent-ink'
                      : 'text-ink-2 hover:bg-surface-2 hover:text-ink'
                  }`
                }
              >
                <Icon className="size-4" aria-hidden />
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1.5">
            <TvhStatus />
            <ThemeButton />
            {auth.data?.username && (
              <button
                type="button"
                onClick={() => logout.mutate()}
                title={`Log out ${auth.data.username}`}
                aria-label="Log out"
                className="rounded-md p-2 text-ink-2 hover:bg-surface-2 hover:text-ink"
              >
                <LogOut className="size-4" aria-hidden />
              </button>
            )}
          </div>
        </div>
        <nav
          aria-label="Main"
          className="flex gap-1 overflow-x-auto border-t border-line px-2 py-1.5 md:hidden"
        >
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm ${
                  isActive ? 'bg-accent-wash font-medium text-accent-ink' : 'text-ink-2'
                }`
              }
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-5 md:py-6">
        <div className="mb-4 empty:hidden">
          <GlobalBanners />
        </div>
        <Outlet />
      </main>
    </div>
  );
}
