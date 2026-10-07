// Normalizes TVHeadend API payloads. Field sets differ between TVH versions, so every field is optional
// and defaulted. Nothing depends on translated text such as the subscription `state`.

export interface TvhSubscription {
  id: number;
  start: number;
  hostname: string | null;
  username: string | null;
  client: string | null;
  title: string;
  channel: string | null;
  service: string | null;
  profile: string | null;
  errors: number;
  /** Current input/output rates as reported by TVH (bytes per second). */
  rateIn: number;
  rateOut: number;
  /** Cumulative bytes for the subscription. */
  totalIn: number;
  totalOut: number;
}

export interface TvhInput {
  /** Tuner display name, e.g. "Silicon Labs Si2168 #0 : DVB-T #0" (stable key; the uuid is not). */
  tuner: string;
  mux: string | null;
  network: string | null;
  subs: number;
  /** Highest subscription weight on the tuner: user streams are >= 10, EPG grab/scans are <= 7. */
  weight: number;
  locked: boolean;
  snrDb: number | null;
  signalDbm: number | null;
  /** Relative values (0–100 %) for drivers that do not report decibels. */
  snrPct: number | null;
  signalPct: number | null;
  ber: number | null;
  /** Cumulative per mux instance; may reset. */
  unc: number;
  te: number;
  cc: number;
  bps: number;
}

export interface ServiceRef {
  tuner: string | null;
  network: string | null;
  mux: string | null;
  service: string | null;
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

export const isRecordingTitle = (title: string | null | undefined): boolean =>
  typeof title === 'string' && title.startsWith('DVR:');

/** Viewers have a client address; recordings are titled "DVR: …". Everything else is TVH-internal. */
export const isClientOrRecording = (s: { hostname: string | null; title: string | null }): boolean =>
  Boolean(s.hostname) || isRecordingTitle(s.title);

/** TVH restarts subscription ids at 1, so the id alone is not unique; with the start time it is. */
export const subKey = (s: { start: number; id: number }): string => `${s.start}-${s.id}`;

export function parseSubscription(e: Record<string, unknown>): TvhSubscription | null {
  const id = num(e.id, Number.NaN);
  const start = num(e.start, Number.NaN);
  if (!Number.isFinite(id) || !Number.isFinite(start)) return null;
  return {
    id,
    start,
    hostname: str(e.hostname),
    username: str(e.username),
    client: str(e.client),
    title: typeof e.title === 'string' ? e.title : '',
    channel: str(e.channel),
    service: str(e.service),
    profile: str(e.profile),
    errors: num(e.errors),
    rateIn: num(e.in),
    rateOut: num(e.out),
    totalIn: num(e.total_in),
    totalOut: num(e.total_out),
  };
}

/**
 * Splits TVH's service nicename "<tuner>/<network>/<mux>/<service>". Parts TVH does not know are left
 * out of the name, so three parts mean no tuner and one part is just the service.
 */
export function parseService(service: string | null | undefined): ServiceRef {
  if (!service) return { tuner: null, network: null, mux: null, service: null };
  const parts = service.split('/');
  if (parts.length >= 4) {
    return {
      tuner: str(parts[0]),
      network: str(parts[1]),
      mux: str(parts[2]),
      service: str(parts.slice(3).join('/')),
    };
  }
  if (parts.length === 3) {
    return { tuner: null, network: str(parts[0]), mux: str(parts[1]), service: str(parts[2]) };
  }
  return { tuner: null, network: null, mux: null, service: str(service) };
}

/** "490MHz in dvb-t" → mux "490MHz", network "dvb-t". */
export function parseStream(stream: unknown): { mux: string | null; network: string | null } {
  const s = str(stream);
  if (!s) return { mux: null, network: null };
  const i = s.lastIndexOf(' in ');
  return i > 0 ? { mux: s.slice(0, i), network: s.slice(i + 4) } : { mux: s, network: null };
}

/** Frequency in MHz from a mux name such as "490MHz" or "205.5MHz". */
export function muxFrequencyMHz(mux: string | null | undefined): number | null {
  const m = mux ? /^(\d+(?:\.\d+)?)\s*MHz$/i.exec(mux.trim()) : null;
  return m ? Number(m[1]) : null;
}

const SCALE_RELATIVE = 1;
const SCALE_DECIBEL = 2;

export function parseInput(e: Record<string, unknown>): TvhInput | null {
  const tuner = str(e.input);
  if (!tuner) return null;
  const { mux, network } = parseStream(e.stream);
  const snrScale = num(e.snr_scale);
  const signalScale = num(e.signal_scale);
  const snr = num(e.snr);
  const signal = num(e.signal);
  const bps = num(e.bps);
  return {
    tuner,
    mux,
    network,
    subs: num(e.subs),
    weight: num(e.weight),
    // The Si2168 demodulator only reports CNR once locked; data flowing also proves lock.
    locked: mux !== null && (snrScale > 0 || bps > 0),
    snrDb: snrScale === SCALE_DECIBEL ? Math.round(snr / 100) / 10 : null,
    signalDbm: signalScale === SCALE_DECIBEL ? Math.round(signal / 100) / 10 : null,
    snrPct: snrScale === SCALE_RELATIVE ? Math.round((snr / 65535) * 1000) / 10 : null,
    signalPct: signalScale === SCALE_RELATIVE ? Math.round((signal / 65535) * 1000) / 10 : null,
    ber: typeof e.ber === 'number' ? e.ber : null,
    unc: num(e.unc),
    te: num(e.te),
    cc: num(e.cc),
    bps,
  };
}
