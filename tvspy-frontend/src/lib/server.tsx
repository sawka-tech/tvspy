// Facts about the server every page needs: its time zone and the SNR thresholds (from /api/status).

import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import type { SnrThresholds } from '../components/viz/snr';
import { useStatus } from './queries';

interface ServerInfo {
  tz: string;
  thresholds: SnrThresholds;
}

const DEFAULTS: ServerInfo = { tz: 'Europe/Warsaw', thresholds: { snrGoodDb: 26, snrCriticalDb: 20 } };
const ServerContext = createContext<ServerInfo>(DEFAULTS);

export function ServerProvider({ children }: { children: ReactNode }) {
  const status = useStatus();
  const value: ServerInfo = status.data
    ? { tz: status.data.timezone, thresholds: status.data.thresholds }
    : DEFAULTS;
  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
}

export const useServer = () => useContext(ServerContext);

/** Current time in ms, updated every `intervalMs`, corrected by the server clock's offset. */
export function useNow(intervalMs = 1000, skewMs = 0): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now + skewMs;
}
