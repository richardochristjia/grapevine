import { describe, expect, it } from "vitest";
import { bestCalls, mergeCalls } from "../src/narratives/calls";
import type { Deps } from "../src/worker";

const A = "A".repeat(32), B = "B".repeat(32), C = "C".repeat(32), D = "D".repeat(32);
function mk(store: Record<string, string>, pairs: unknown[] = []) {
  const puts: [string, { expirationTtl?: number } | undefined][] = [];
  const deps: Deps = {
    fetch: (async () => Response.json({ pairs })) as unknown as typeof fetch,
    kv: { get: async (k) => store[k] ?? null, put: async (k, v, o) => { store[k] = v; puts.push([k, o]); }, list: async () => ({ keys: [] }) },
    now: () => new Date("2026-10-31T10:00:00Z"),
  };
  return { deps, puts };
}
const tok = (mint: string, mcap: number | null) => ({ mint, symbol: mint[0], name: null, mcap, sources: ["jupiter"] });
const call = (mcap: number | null) => ({ firstSeen: "x", mcap, symbol: "S", sources: [] });

describe("mergeCalls", () => {
  it("adds only new mints, dedupes 7 days, one put with 8d ttl", async () => {
    const store = { "calls:2026-10-27": JSON.stringify({ [A]: call(1) }), "calls:2026-10-20": JSON.stringify({ [B]: call(1) }) };
    const { deps, puts } = mk(store);
    const added = await mergeCalls(deps, [tok(A, 5), tok(B, 5), tok(C, 5)]);
    expect(added).toEqual([B, C]); // B is 11 days old, outside the window
    expect(puts).toHaveLength(1);
    expect(puts[0][0]).toBe("calls:2026-10-31");
    expect(puts[0][1]).toEqual({ expirationTtl: 8 * 86400 });
    expect(Object.keys(JSON.parse(store["calls:2026-10-31" as keyof typeof store] as string))).toEqual([B, C]);
  });

  it("skips tokens without a positive mcap", async () => {
    const store: Record<string, string> = {};
    const { deps, puts } = mk(store);
    expect(await mergeCalls(deps, [tok(A, null), tok(B, 0), tok(C, 5)])).toEqual([C]);
    expect(puts).toHaveLength(1);
  });
  it("logs a mint first seen without mcap once a later hour has one", async () => {
    const store: Record<string, string> = {};
    expect(await mergeCalls(mk(store).deps, [tok(A, null)])).toEqual([]); // hour 1
    expect(await mergeCalls(mk(store).deps, [tok(A, 100_000)])).toEqual([A]); // hour 2
    expect(JSON.parse(store["calls:2026-10-31"])[A].mcap).toBe(100_000);
    const pair = { baseToken: { address: A }, marketCap: 500_000, liquidity: { usd: 1 } };
    expect((await bestCalls(mk(store, [pair]).deps)).map((x) => [x.mint, x.multiple])).toEqual([[A, 5]]);
  });
});

describe("bestCalls", () => {
  it("ranks 100k to 500k as 5x and skips zero first mcap", async () => {
    const store = { "calls:2026-10-30": JSON.stringify({ [A]: call(100_000), [B]: call(0), [C]: call(100_000), [D]: call(null) }) };
    const pair = (m: string, mcap: number, liq: number) => ({ baseToken: { address: m }, marketCap: mcap, liquidity: { usd: liq } });
    const { deps } = mk(store, [pair(A, 500_000, 10), pair(A, 999, 5), pair(B, 1e9, 1), pair(C, 200_000, 1), pair(D, 1e9, 1)]);
    const r = await bestCalls(deps);
    expect(r.map((x) => [x.mint, x.multiple])).toEqual([[A, 5], [C, 2]]);
  });
});
