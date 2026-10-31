// usage: node scripts/record-fixture.mjs <mint> <green|yellow|red>
// Mirrors src/analyze/sources.ts extraction; stores each source as a Result.
import { mkdirSync, writeFileSync } from "node:fs";

const [mint, label] = process.argv.slice(2);
if (!mint || !["green", "yellow", "red"].includes(label)) {
  console.error("usage: record-fixture.mjs <mint> <green|yellow|red>");
  process.exit(1);
}
const get = async (url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    return r.ok ? { ok: true, data: await r.json() } : { ok: false, reason: `http_${r.status}` };
  } catch {
    return { ok: false, reason: "error" };
  }
};
const pick = (r, f) => {
  if (!r.ok) return r;
  const t = f(r.data);
  return t ? { ok: true, data: t } : { ok: false, reason: "not_found" };
};
const [gp, jup, ds] = await Promise.all([
  get(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${mint}`),
  get(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`),
  get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`),
]);
const fx = {
  mint,
  label,
  goplus: pick(gp, (d) => d?.result?.[mint]),
  jupiter: pick(jup, (d) => (Array.isArray(d) ? d.find((x) => x?.id === mint) : undefined)),
  dexscreener: ds,
  tracker: null,
};
const symbol = (fx.jupiter.data?.symbol ?? "unknown").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
mkdirSync("test/fixtures/tokens", { recursive: true });
const file = `test/fixtures/tokens/${label}-${symbol}.json`;
writeFileSync(file, JSON.stringify(fx, null, 2) + "\n");
console.log(file, Object.entries(fx).filter(([, v]) => v && typeof v === "object").map(([k, v]) => `${k}:${v.ok}`).join(" "));
