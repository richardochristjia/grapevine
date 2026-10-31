import type { Deps } from "../worker";
import type { CollectedToken } from "./collect";

export interface Call { firstSeen: string; mcap: number | null; symbol: string | null; sources: string[] }
export type CallsDay = Record<string, Call>;
export interface BestCall { mint: string; symbol: string | null; firstMcap: number; nowMcap: number; multiple: number }

export const TTL = 8 * 86400;
const dayKey = (d: Date) => `calls:${d.toISOString().slice(0, 10)}`;
const lastDays = (now: Date, n = 7) => Array.from({ length: n }, (_, i) => dayKey(new Date(now.getTime() - i * 86400000)));

async function readDays(deps: Deps): Promise<CallsDay[]> {
  return Promise.all(
    lastDays(deps.now()).map(async (k) => {
      try {
        return JSON.parse((await deps.kv.get(k)) ?? "{}") as CallsDay;
      } catch {
        return {};
      }
    }),
  );
}

/** Adds mints with a market cap, unseen in the last 7 days, to today's key with exactly one put. */
export async function mergeCalls(deps: Deps, tokens: CollectedToken[]): Promise<string[]> {
  const [today, ...older] = await readDays(deps);
  const seen = new Set([today, ...older].flatMap((d) => Object.keys(d)));
  const added: string[] = [];
  for (const t of tokens) {
    // a call without a market cap cannot be ranked, and its dedupe entry would block the real one
    if (seen.has(t.mint) || !(t.mcap && t.mcap > 0)) continue;
    seen.add(t.mint);
    added.push(t.mint);
    today[t.mint] = { firstSeen: deps.now().toISOString(), mcap: t.mcap, symbol: t.symbol, sources: t.sources };
  }
  await deps.kv.put(dayKey(deps.now()), JSON.stringify(today), { expirationTtl: TTL });
  return added;
}

export async function bestCalls(deps: Deps): Promise<BestCall[]> {
  const ck = "https://cache.local/best-calls";
  const hit = await deps.cache?.match(ck);
  if (hit) return hit.json();

  const calls: Record<string, Call> = Object.assign({}, ...(await readDays(deps)).reverse());
  const mints = Object.keys(calls).filter((m) => (calls[m].mcap ?? 0) > 0);
  const now = new Map<string, { liq: number; mcap: number }>();
  for (let i = 0; i < mints.length; i += 30) {
    try {
      const r = await deps.fetch(`https://api.dexscreener.com/latest/dex/tokens/${mints.slice(i, i + 30).join(",")}`, { signal: AbortSignal.timeout(5000) });
      // biome-ignore lint: raw third-party JSON
      const pairs: any[] = r.ok ? ((await r.json()) as any).pairs ?? [] : [];
      for (const p of pairs) {
        const m = p.baseToken?.address;
        const liq = Number(p.liquidity?.usd) || 0;
        const mcap = Number(p.marketCap ?? p.fdv) || 0;
        if (m && mcap > 0 && liq >= (now.get(m)?.liq ?? -1)) now.set(m, { liq, mcap });
      }
    } catch {}
  }
  const out = mints
    .filter((m) => now.has(m))
    .map((m) => ({ mint: m, symbol: calls[m].symbol, firstMcap: calls[m].mcap!, nowMcap: now.get(m)!.mcap, multiple: now.get(m)!.mcap / calls[m].mcap! }))
    .sort((a, b) => b.multiple - a.multiple)
    .slice(0, 10);
  await deps.cache?.put(ck, new Response(JSON.stringify(out), { headers: { "cache-control": "max-age=600" } })).catch(() => {});
  return out;
}
