export type RecapKind = "hourly" | "24h" | "asia" | "europe" | "us";

// UTC hour -> session recap (decided by hour only, so a late cron still counts)
const SESSIONS: Record<number, RecapKind> = { 0: "24h", 8: "asia", 16: "europe", 21: "us" };
export const WINDOW_HOURS: Record<RecapKind, number> = { hourly: 1, "24h": 24, asia: 8, europe: 8, us: 5 };

export function dueRecaps(date: Date): RecapKind[] {
  const s = SESSIONS[date.getUTCHours()];
  return s ? ["hourly", s] : ["hourly"];
}
