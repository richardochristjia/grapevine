import type { Deps } from "../worker";

export type Result<T = unknown> = { ok: true; data: T } | { ok: false; reason: string };

// biome-ignore lint: raw third-party JSON
export type Json = any;

async function getJson(deps: Deps, url: string, init: RequestInit = {}): Promise<Result<Json>> {
  try {
    const res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
    if (res.status === 429) return { ok: false, reason: "quota" };
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, reason: e instanceof Error && e.name === "TimeoutError" ? "timeout" : "error" };
  }
}

export async function fetchGoPlus(mint: string, deps: Deps): Promise<Result<Json>> {
  const r = await getJson(deps, `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${mint}`);
  if (!r.ok) return r;
  const t = r.data?.result?.[mint];
  return t && typeof t === "object" ? { ok: true, data: t } : { ok: false, reason: "not_found" };
}

export async function fetchJupiter(mint: string, deps: Deps): Promise<Result<Json>> {
  const r = await getJson(deps, `https://lite-api.jup.ag/tokens/v2/search?query=${mint}`);
  if (!r.ok) return r;
  const t = Array.isArray(r.data) ? r.data.find((x: Json) => x?.id === mint) : undefined;
  return t ? { ok: true, data: t } : { ok: false, reason: "not_found" };
}

/** data.pairs may be null for tokens with no pools. */
export async function fetchDexScreener(mint: string, deps: Deps): Promise<Result<Json>> {
  return getJson(deps, `https://api.dexscreener.com/latest/dex/tokens/${mint}`);
}

export async function fetchSolanaTracker(mint: string, key: string, deps: Deps): Promise<Result<Json>> {
  const ck = `https://cache.local/st/${mint}`;
  const hit = await deps.cache?.match(ck);
  if (hit) return { ok: true, data: await hit.json() };
  const r = await getJson(deps, `https://data.solanatracker.io/tokens/${mint}`, { headers: { "x-api-key": key } });
  if (r.ok) {
    await deps.cache
      ?.put(ck, new Response(JSON.stringify(r.data), { headers: { "cache-control": "max-age=3600" } }))
      .catch(() => {});
  }
  return r;
}
