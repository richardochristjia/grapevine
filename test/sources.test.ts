import { describe, expect, it } from "vitest";
import { analyze, isValidMint, toSignals } from "../src/analyze/analyze";
import type { Deps } from "../src/worker";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const healthy: Record<string, unknown> = {
  "gopluslabs.io": { result: { [MINT]: {
    mintable: { status: "0" }, freezable: { status: "0" }, metadata_mutable: { status: "1" },
    transfer_fee: {}, transfer_hook: [], dex: [{ burn_percent: null }] } } },
  "jup.ag": [{ id: MINT, symbol: "Bonk", organicScoreLabel: "high", stats24h: { priceChange: -1 },
    audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 30.17, devMints: 10 } }],
  "dexscreener.com": { pairs: [{ chainId: "solana", liquidity: { usd: 400000 }, info: { socials: [{ type: "twitter" }], websites: [] } }] },
};

function deps(over: Record<string, () => Response | Promise<Response>> = {}, calls: string[] = []): Deps {
  const store = new Map<string, string>();
  return {
    fetch: (async (url: string) => {
      calls.push(url);
      const host = Object.keys({ ...healthy, "solanatracker.io": 1 }).find((h) => url.includes(h))!;
      if (over[host]) return over[host]();
      return Response.json(healthy[host]);
    }) as unknown as typeof fetch,
    kv: { get: async () => null, put: async () => {}, list: async () => ({ keys: [] }) },
    now: () => new Date("2026-10-31T00:00:00Z"),
    cache: {
      match: async (k) => (store.has(k) ? new Response(store.get(k)) : undefined),
      put: async (k, r) => void store.set(k, await r.text()),
    },
  };
}

describe("isValidMint", () => {
  it("accepts base58 32-44, rejects others", () => {
    expect(isValidMint(MINT)).toBe(true);
    expect(isValidMint("short")).toBe(false);
    expect(isValidMint("0OIl" + MINT)).toBe(false);
  });
});

describe("analyze", () => {
  it("healthy token is Green, tracker notChecked", async () => {
    const r = await analyze(MINT, deps(), { withTracker: true });
    expect(r.verdict).toBe("Green");
    expect(r.symbol).toBe("Bonk");
    expect(r.notChecked).toEqual(["solanatracker"]);
    expect(r.unknown).toEqual([]);
  });
  it.each([
    ["error", () => { throw new Error("boom"); }],
    ["timeout", () => { throw new DOMException("t", "TimeoutError"); }],
    ["5xx", () => new Response("no", { status: 503 })],
  ])("source %s -> unknown, never Green", async (_n, f) => {
    const r = await analyze(MINT, deps({ "gopluslabs.io": f }), { withTracker: false });
    expect(r.unknown).toEqual(["goplus"]);
    expect(r.verdict).not.toBe("Green");
  });
  it("tracker 429 -> unknown quota, Yellow", async () => {
    const r = await analyze(MINT, deps({ "solanatracker.io": () => new Response("", { status: 429 }) }), { withTracker: true, trackerKey: "k" });
    expect(r.unknown).toEqual(["solanatracker"]);
    expect(r.verdict).toBe("Yellow");
  });
  it("tracker data maps risk fields and is cached", async () => {
    const calls: string[] = [];
    const d = deps({ "solanatracker.io": () => Response.json({ risk: { snipers: { totalPercentage: 25 }, rugged: false } }) }, calls);
    const r = await analyze(MINT, d, { withTracker: true, trackerKey: "k" });
    expect(r.flags.find((f) => f.id === "snipers")?.points).toBe(25);
    await analyze(MINT, d, { withTracker: true, trackerKey: "k" });
    expect(calls.length).toBe(4); // second call served from analyze cache
  });
  it("jupiter without matching id is unknown", async () => {
    const r = await analyze(MINT, deps({ "jup.ag": () => Response.json([]) }), { withTracker: false });
    expect(r.unknown).toEqual(["jupiter"]);
  });
  it("null pairs and missing audit give null signals, not passes", () => {
    const s = toSignals({ goplus: null, jupiter: { ok: true, data: { id: MINT } }, dexscreener: { ok: true, data: { pairs: null } }, tracker: null });
    expect(s.liquidityUsd).toBeNull();
    expect(s.mintAuthority).toBeNull();
    expect(s.top10Pct).toBeNull();
  });
  it.each([
    ["null", { pairs: null }],
    ["empty", { pairs: [] }],
    ["non-solana", { pairs: [{ chainId: "ethereum", liquidity: { usd: 1e6 } }] }],
  ])("dexscreener ok with %s pairs -> unknown, Yellow with incomplete_data", async (_n, body) => {
    const r = await analyze(MINT, deps({ "dexscreener.com": () => Response.json(body) }), { withTracker: false });
    expect(r.unknown).toEqual(["dexscreener"]);
    expect(r.checked).not.toContain("dexscreener");
    expect(r.verdict).toBe("Yellow");
    expect(r.flags.map((f) => f.id)).toContain("incomplete_data");
  });
  it("GoPlus mintable status 1 -> mint_authority hard flag", async () => {
    const bad = { result: { [MINT]: { ...(healthy["gopluslabs.io"] as any).result[MINT], mintable: { status: "1" } } } };
    const r = await analyze(MINT, deps({ "gopluslabs.io": () => Response.json(bad) }), { withTracker: false });
    expect(r.verdict).toBe("Red");
  });
});
