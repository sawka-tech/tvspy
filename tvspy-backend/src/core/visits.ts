// A "visit" groups channel zapping into one viewing occasion: sessions of the same user in the same app
// where each starts at most `gapSec` after the previous one ended. Watch time and data are unaffected;
// only session counts use visits.

export interface VisitInput {
  id: number;
  user: string | null;
  app: string | null;
  start: number;
  end: number;
}

export const DEFAULT_VISIT_GAP_SEC = 60;

/** Returns, per session id, the id of the first session of its visit. */
export function assignVisits(
  sessions: readonly VisitInput[],
  gapSec = DEFAULT_VISIT_GAP_SEC,
): Map<number, number> {
  const groups = new Map<string, VisitInput[]>();
  for (const s of sessions) {
    const key = `${s.user ?? ''}\u0000${s.app ?? ''}`;
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }

  const visitOf = new Map<number, number>();
  for (const list of groups.values()) {
    list.sort((a, b) => a.start - b.start || a.id - b.id);
    let visitId: number | null = null;
    let visitEnd = Number.NEGATIVE_INFINITY;
    for (const s of list) {
      if (visitId !== null && s.start - visitEnd <= gapSec) {
        visitEnd = Math.max(visitEnd, s.end);
      } else {
        visitId = s.id;
        visitEnd = s.end;
      }
      visitOf.set(s.id, visitId);
    }
  }
  return visitOf;
}
