import type { Deps } from "../worker";
import { fetchDexScreener, fetchGoPlus, fetchJupiter, fetchSolanaTracker, type Json, type Result } from "./sources";
import { score, type Flag, type Signals, type Verdict } from "./rules";

export interface Raw {
  goplus: Result<Json> | null;
  jupiter: Result<Json> | null;
  dexscreener: Result<Json> | null;
  tracker: Result<Json> | null;
}

export interface AnalyzeResponse {
  mint: string;
  symbol: string | null;
  verdict: Verdict;
  score: number;
  flags: Flag[];
  checked: string[];
  unknown: string[];
  notChecked: string[];
  fetchedAt: string;
}

export const isValidMint = (s: string): boolean => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const data = (r: Result<Json> | null): Json | null => (r?.ok ? r.data : null);
// any true wins; else any definite false; else unknown
const combine = (...v: (boolean | null)[]): boolean | null =>
  v.includes(true) ? true : v.includes(false) ? false : null;
const flagOf = (disabled: unknown) => (typeof disabled === "boolean" ? !disabled : null);
const status = (o: Json) => (o?.status === "1" ? true : o?.status === "0" ? false : null);

export function toSignals(raw: Raw): Signals {
  const gp = data(raw.goplus), jup = data(raw.jupiter), ds = data(raw.dexscreener), tr = data(raw.tracker);
  const audit = jup?.audit ?? {};
  const pairs: Json[] | null = Array.isArray(ds?.pairs) && ds.pairs.length
    ? ds.pairs.filter((p: Json) => p?.chainId === "solana")
    : null;
  const burns = ((gp?.dex ?? []) as Json[]).map((d) => num(d?.burn_percent)).filter((n): n is number => n !== null);
  const risk = tr?.risk;
  return {
    mintAuthority: combine(flagOf(audit.mintAuthorityDisabled), status(gp?.mintable)),
    freezeAuthority: combine(flagOf(audit.freezeAuthorityDisabled), status(gp?.freezable)),
    metadataMutable: gp ? status(gp.metadata_mutable) : null,
    transferHook: gp ? Array.isArray(gp.transfer_hook) && gp.transfer_hook.length > 0 : null,
    transferFee: gp ? !!gp.transfer_fee && typeof gp.transfer_fee === "object" && Object.keys(gp.transfer_fee).length > 0 : null,
    liquidityUsd: pairs?.length ? pairs.reduce((a, p) => a + (num(p.liquidity?.usd) ?? 0), 0) : null,
    lpBurnPct: burns.length ? Math.max(...burns) : null,
    top10Pct: num(audit.topHoldersPercentage),
    devPct: num(audit.devBalancePercentage),
    devMints: num(audit.devMints),
    organicLabel: typeof jup?.organicScoreLabel === "string" ? jup.organicScoreLabel : null,
    hasSocials: pairs?.length
      ? pairs.some((p) => (p.info?.socials?.length ?? 0) > 0 || (p.info?.websites?.length ?? 0) > 0)
      : null,
    priceChange24h: num(jup?.stats24h?.priceChange) ?? num(pairs?.[0]?.priceChange?.h24),
    snipersPct: num(risk?.snipers?.totalPercentage),
    insidersPct: num(risk?.insiders?.totalPercentage),
    bundlersPct: num(risk?.bundlers?.totalPercentage),
    rugged: typeof risk?.rugged === "boolean" ? risk.rugged : null,
  };
}

export async function analyze(
  mint: string,
  deps: Deps,
  opts: { withTracker: boolean; trackerKey?: string },
): Promise<AnalyzeResponse> {
  const useTracker = opts.withTracker && !!opts.trackerKey;
  // tracker-less results get their own key so a cron run never serves a user a result missing tracker data
  const ck = `https://cache.local/analyze/${mint}${useTracker ? "" : "?nt"}`;
  const hit = await deps.cache?.match(ck);
  if (hit) return hit.json();

  const [goplus, jupiter, dexscreener, tracker] = await Promise.all([
    fetchGoPlus(mint, deps),
    fetchJupiter(mint, deps),
    fetchDexScreener(mint, deps),
    useTracker ? fetchSolanaTracker(mint, opts.trackerKey!, deps) : Promise.resolve(null),
  ]);
  const raw: Raw = { goplus, jupiter, dexscreener, tracker };
  const names: [string, Result<Json> | null][] = [
    ["goplus", goplus], ["jupiter", jupiter], ["dexscreener", dexscreener], ["solanatracker", tracker],
  ];
  // DexScreener answering with no solana pair means liquidity is unknown, not a pass
  const ds = data(dexscreener);
  const noPairs = !!dexscreener?.ok && !(Array.isArray(ds?.pairs) && ds.pairs.some((p: Json) => p?.chainId === "solana"));
  const checked = names.filter(([n, r]) => r?.ok && !(noPairs && n === "dexscreener")).map(([n]) => n);
  const unknown = names.filter(([n, r]) => (r && !r.ok) || (noPairs && n === "dexscreener")).map(([n]) => n);
  const notChecked = names.filter(([, r]) => r === null).map(([n]) => n);

  const res: AnalyzeResponse = {
    mint,
    symbol: data(jupiter)?.symbol ?? data(dexscreener)?.pairs?.[0]?.baseToken?.symbol ?? null,
    ...score(toSignals(raw), { unknown }),
    checked,
    unknown,
    notChecked,
    fetchedAt: deps.now().toISOString(),
  };
  // transient failures are not cached so the next request retries
  if (!unknown.length) {
    await deps.cache
      ?.put(ck, new Response(JSON.stringify(res), { headers: { "cache-control": "max-age=300" } }))
      .catch(() => {});
  }
  return res;
}
