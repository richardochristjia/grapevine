import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collect, MAX_TOKENS } from "../src/narratives/collect";
import type { Deps } from "../src/worker";

const fx = (n: string) => readFileSync(`${import.meta.dirname}/fixtures/feeds/${n}.json`, "utf8");
const BODY: Record<string, string> = {
  "geckoterminal.com": fx("geckoterminal"), "jup.ag": fx("jupiter"), "dexscreener.com": fx("dexscreener-boosts"),
  "coingecko.com": fx("coingecko"), "warpcast.com": fx("farcaster"),
};
const mk = (over: Record<string, () => Response | Promise<Response>> = {}): Deps => ({
  fetch: (async (u: string) => {
    const h = Object.keys(BODY).find((k) => u.includes(k))!;
    return over[h] ? over[h]() : new Response(BODY[h]);
  }) as unknown as typeof fetch,
  kv: { get: async () => null, put: async () => {}, list: async () => ({ keys: [] }) },
  now: () => new Date("2026-10-31T00:00:00Z"),
});
const MINT_A = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

describe("collect", () => {
  it("extracts, dedupes and caps from recorded feeds", async () => {
    const c = await collect(mk());
    expect(c.failedFeeds).toEqual([]);
    expect(c.tokens.length).toBeGreaterThan(5);
    expect(c.tokens.length).toBeLessThanOrEqual(MAX_TOKENS);
    expect(new Set(c.tokens.map((t) => t.mint)).size).toBe(c.tokens.length);
    const counts = c.tokens.map((t) => t.sources.length);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(c.tokens.every((t) => !t.mint.startsWith("solana_"))).toBe(true);
    expect(c.themes.length).toBeGreaterThan(0);
    expect(c.casts.length).toBeGreaterThan(0);
  });

  it("skips a failed feed and records it", async () => {
    const c = await collect(mk({ "jup.ag": () => new Response("x", { status: 500 }), "warpcast.com": () => { throw new Error("boom"); } }));
    expect(c.failedFeeds).toEqual(["jupiter", "farcaster"]);
    expect(c.tokens.length).toBeGreaterThan(0);
  });

  it("dedupes one mint across feeds and keeps both sources", async () => {
    const gt = { data: [{ attributes: { name: "BONK / SOL", market_cap_usd: "5", volume_usd: { h24: "9" } }, relationships: { base_token: { data: { id: `solana_${MINT_A}` } } } }] };
    const c = await collect(mk({
      "geckoterminal.com": () => Response.json(gt),
      "jup.ag": () => Response.json([{ id: MINT_A, symbol: "Bonk", name: "Bonk", mcap: 7 }]),
      "dexscreener.com": () => Response.json([]),
    }));
    const t = c.tokens.find((x) => x.mint === MINT_A)!;
    expect(t.sources.sort()).toEqual(["geckoterminal", "jupiter"]);
    expect(t.symbol).toBe("BONK");
  });

  it("caps at MAX_TOKENS", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ chainId: "solana", tokenAddress: `${"1".repeat(31)}${String.fromCharCode(65 + (i % 26))}${i < 26 ? "" : "z"}` }));
    const c = await collect(mk({ "dexscreener.com": () => Response.json(many) }));
    expect(c.tokens.length).toBe(MAX_TOKENS);
  });

  it("cashtags count but never become mints; casts with mints do", async () => {
    const casts = { result: { casts: [{ text: `buy $WIF $wif $SOL ${MINT_A}`, author: { username: "a" }, timestamp: 1, reactions: { count: 2 } }] } };
    const c = await collect(mk({ "warpcast.com": () => Response.json(casts), "geckoterminal.com": () => new Response("", { status: 500 }), "jup.ag": () => Response.json([]), "dexscreener.com": () => Response.json([]) }));
    expect(c.cashtags).toEqual({ WIF: 2, SOL: 1 });
    expect(c.tokens.some((t) => t.mint === "WIF" || t.mint === "SOL")).toBe(false);
    expect(c.tokens.find((t) => t.mint === MINT_A)?.sources).toContain("farcaster");
  });
});
