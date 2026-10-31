export interface Signals {
  mintAuthority: boolean | null;
  freezeAuthority: boolean | null;
  metadataMutable: boolean | null;
  transferHook: boolean | null;
  transferFee: boolean | null;
  liquidityUsd: number | null;
  lpBurnPct: number | null;
  top10Pct: number | null;
  devPct: number | null;
  devMints: number | null;
  organicLabel: string | null;
  hasSocials: boolean | null;
  priceChange24h: number | null;
  snipersPct: number | null;
  insidersPct: number | null;
  bundlersPct: number | null;
  rugged: boolean | null;
}

export interface Flag {
  id: string;
  severity: "hard" | "soft";
  points: number;
  message: string;
}
export type Verdict = "Red" | "Yellow" | "Green";
export interface Score {
  verdict: Verdict;
  score: number;
  flags: Flag[];
}

const tier = (v: number | null, steps: [number, number][]): number => {
  if (v === null) return 0;
  let p = 0;
  for (const [t, pts] of steps) if (v > t) p = pts;
  return p;
};

export function score(s: Signals, opts: { unknown: string[] }): Score {
  const flags: Flag[] = [];
  const hard = (id: string, message: string) => flags.push({ id, severity: "hard", points: 100, message });
  const soft = (id: string, points: number, message: string) => {
    if (points > 0) flags.push({ id, severity: "soft", points, message });
  };

  if (s.mintAuthority) hard("mint_authority", "Mint authority is not revoked: supply can be inflated.");
  if (s.freezeAuthority) hard("freeze_authority", "Freeze authority is not revoked: wallets can be frozen.");
  if (s.transferHook) hard("transfer_hook", "Token has a transfer hook that can block or tax transfers.");
  if (s.transferFee) hard("transfer_fee", "Token charges a transfer fee.");
  if (s.rugged) hard("rugged", "Solana Tracker marks this token as rugged.");
  if (s.liquidityUsd !== null && s.liquidityUsd < 1000) hard("liquidity_pulled", "Liquidity is under $1,000.");
  if (s.liquidityUsd !== null && s.liquidityUsd < 10000 && s.lpBurnPct !== null && s.lpBurnPct < 90)
    hard("lp_unlocked_tiny", "Small liquidity and the LP is not burned.");

  // top10 caps at +20: real blue chips (RAY 79%) hold supply in protocol wallets
  soft("top10", tier(s.top10Pct, [[15, 10], [30, 20]]), `Top 10 holders own ${s.top10Pct}%.`);
  soft("dev_holds", tier(s.devPct, [[1, 10], [10, 25]]), `Dev holds ${s.devPct}%.`);
  soft("snipers", tier(s.snipersPct, [[10, 10], [20, 25]]), `Snipers hold ${s.snipersPct}%.`);
  soft("insiders", tier(s.insidersPct, [[10, 10], [20, 25]]), `Insiders hold ${s.insidersPct}%.`);
  soft("bundlers", tier(s.bundlersPct, [[10, 10], [20, 25]]), `Bundlers hold ${s.bundlersPct}%.`);
  soft("dev_mints", tier(s.devMints, [[25, 10], [100, 20]]), `Dev has minted ${s.devMints} tokens.`);
  soft("organic", s.organicLabel === "low" ? 15 : s.organicLabel === "medium" ? 5 : 0, `Organic score is ${s.organicLabel}.`);
  soft("no_socials", s.hasSocials === false ? 10 : 0, "No website or socials listed.");
  soft("price_drop", s.priceChange24h !== null && s.priceChange24h < -50 ? 10 : 0, `Price fell ${s.priceChange24h}% in 24h.`);
  soft("metadata_mutable", s.metadataMutable ? 5 : 0, "Metadata can still be changed.");
  soft("lp_unknown", s.lpBurnPct === null && s.liquidityUsd !== null && s.liquidityUsd < 50000 ? 5 : 0, "LP lock status unknown.");

  const total = Math.min(100, flags.reduce((a, f) => a + f.points, 0));
  let verdict: Verdict = flags.some((f) => f.severity === "hard") ? "Red" : total <= 30 ? "Green" : total <= 60 ? "Yellow" : "Red";
  if (verdict === "Green" && opts.unknown.length) {
    verdict = "Yellow";
    flags.push({ id: "incomplete_data", severity: "soft", points: 0, message: `Could not check: ${opts.unknown.join(", ")}.` });
  }
  return { verdict, score: total, flags };
}
