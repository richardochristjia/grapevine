import { isValidMint } from "../analyze/analyze";
import type { Json } from "../analyze/sources";
import type { Deps } from "../worker";

export interface CollectedToken {
  mint: string;
  symbol: string | null;
  name: string | null;
  mcap: number | null;
  sources: string[];
}
export interface Cast { text: string; author: string; timestamp: number; reactions: number }
export interface Collected {
  tokens: CollectedToken[];
  themes: string[];
  casts: Cast[];
  cashtags: Record<string, number>;
  failedFeeds: string[];
}

const FEEDS = {
  geckoterminal: "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools",
  jupiter: "https://lite-api.jup.ag/tokens/v2/toptrending/1h?limit=20",
  dexscreener: "https://api.dexscreener.com/token-boosts/top/v1",
  coingecko: "https://api.coingecko.com/api/v3/search/trending",
  farcaster: "https://api.warpcast.com/v2/search-casts?q=solana&limit=50",
} as const;

// Workers Free allows 50 subrequests per run (KV ops count): 5 feeds + 3 per token + KV + LLM
export const MAX_TOKENS = 8;
const nn = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

export async function collect(deps: Deps): Promise<Collected> {
  const names = Object.keys(FEEDS) as (keyof typeof FEEDS)[];
  const got = await Promise.all(
    names.map(async (n): Promise<Json> => {
      try {
        const r = await deps.fetch(FEEDS[n], { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
        return r.ok ? await r.json() : null;
      } catch {
        return null;
      }
    }),
  );
  const feed: Record<string, Json> = Object.fromEntries(names.map((n, i) => [n, got[i]]));
  const failedFeeds = names.filter((n) => !feed[n]);

  const byMint = new Map<string, CollectedToken & { vol: number }>();
  const add = (mint: unknown, src: string, p: Partial<CollectedToken> & { vol?: number } = {}) => {
    if (typeof mint !== "string" || !isValidMint(mint)) return;
    const t = byMint.get(mint) ?? { mint, symbol: null, name: null, mcap: null, sources: [], vol: 0 };
    if (!t.sources.includes(src)) t.sources.push(src);
    t.symbol ??= p.symbol ?? null;
    t.name ??= p.name ?? null;
    t.mcap ??= p.mcap ?? null;
    t.vol = Math.max(t.vol, p.vol ?? 0);
    byMint.set(mint, t);
  };

  for (const p of feed.geckoterminal?.data ?? []) {
    const a = p.attributes ?? {};
    const base = String(a.name ?? "").split(" / ")[0] || null;
    add(String(p.relationships?.base_token?.data?.id ?? "").replace(/^solana_/, ""), "geckoterminal", {
      symbol: base, name: base, mcap: nn(a.market_cap_usd) ?? nn(a.fdv_usd), vol: nn(a.volume_usd?.h24) ?? 0,
    });
  }
  for (const t of Array.isArray(feed.jupiter) ? feed.jupiter : []) {
    const s = t.stats24h ?? {};
    add(t.id, "jupiter", { symbol: t.symbol, name: t.name, mcap: nn(t.mcap), vol: (nn(s.buyVolume) ?? 0) + (nn(s.sellVolume) ?? 0) });
  }
  for (const t of Array.isArray(feed.dexscreener) ? feed.dexscreener : []) {
    if (t.chainId === "solana") add(t.tokenAddress, "dexscreener");
  }

  const casts: Cast[] = (feed.farcaster?.result?.casts ?? []).map((c: Json) => ({
    text: String(c.text ?? ""), author: String(c.author?.username ?? ""),
    timestamp: Number(c.timestamp) || 0, reactions: nn(c.reactions?.count) ?? 0,
  }));
  const cashtags: Record<string, number> = {};
  for (const c of casts) {
    for (const w of c.text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) ?? []) add(w, "farcaster");
    for (const m of c.text.matchAll(/\$([A-Za-z][A-Za-z0-9]{1,9})\b/g)) {
      const k = m[1].toUpperCase();
      cashtags[k] = (cashtags[k] ?? 0) + 1;
    }
  }

  const tokens = [...byMint.values()]
    .sort((a, b) => b.sources.length - a.sources.length || b.vol - a.vol)
    .slice(0, MAX_TOKENS)
    .map(({ vol: _v, ...t }) => t);
  const themes = (feed.coingecko?.coins ?? []).flatMap((c: Json) => [c.item?.name, c.item?.symbol]).filter(Boolean);
  return { tokens, themes, casts, cashtags, failedFeeds };
}
