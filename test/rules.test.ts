import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toSignals, type Raw } from "../src/analyze/analyze";
import { score, type Signals } from "../src/analyze/rules";

const clean: Signals = {
  mintAuthority: false, freezeAuthority: false, metadataMutable: false, transferHook: false, transferFee: false,
  liquidityUsd: 500000, lpBurnPct: 100, top10Pct: 5, devPct: 0, devMints: 1, organicLabel: "high",
  hasSocials: true, priceChange24h: 0, snipersPct: null, insidersPct: null, bundlersPct: null, rugged: null,
};
const run = (o: Partial<Signals>, unknown: string[] = []) => score({ ...clean, ...o }, { unknown });

describe("hard flags", () => {
  it.each([
    ["mint_authority", { mintAuthority: true }],
    ["freeze_authority", { freezeAuthority: true }],
    ["transfer_hook", { transferHook: true }],
    ["transfer_fee", { transferFee: true }],
    ["rugged", { rugged: true }],
    ["liquidity_pulled", { liquidityUsd: 999 }],
    ["lp_unlocked_tiny", { liquidityUsd: 5000, lpBurnPct: 0 }],
  ] as [string, Partial<Signals>][])("%s gives Red", (id, o) => {
    const r = run(o);
    expect(r.verdict).toBe("Red");
    expect(r.flags.map((f) => f.id)).toContain(id);
  });
  it("lp_unlocked_tiny needs known burn below 90 and liquidity under 10k", () => {
    expect(run({ liquidityUsd: 5000, lpBurnPct: null }).flags.map((f) => f.id)).not.toContain("lp_unlocked_tiny");
    expect(run({ liquidityUsd: 5000, lpBurnPct: 95 }).verdict).not.toBe("Red");
    expect(run({ liquidityUsd: 20000, lpBurnPct: 0 }).verdict).not.toBe("Red");
  });
});

describe("soft thresholds", () => {
  const pts = (o: Partial<Signals>) => run(o).score;
  it("top10", () => {
    expect([15, 16, 30, 31, 50, 51].map((v) => pts({ top10Pct: v }))).toEqual([0, 10, 10, 20, 20, 20]);
  });
  it("dev, tracker, devMints", () => {
    expect([1, 2, 10, 11].map((v) => pts({ devPct: v }))).toEqual([0, 10, 10, 25]);
    expect([10, 11, 20, 21].map((v) => pts({ snipersPct: v }))).toEqual([0, 10, 10, 25]);
    expect(pts({ insidersPct: 30 })).toBe(25);
    expect(pts({ bundlersPct: 15 })).toBe(10);
    expect([25, 26, 100, 101].map((v) => pts({ devMints: v }))).toEqual([0, 10, 10, 20]);
  });
  it("others", () => {
    expect(pts({ organicLabel: "medium" })).toBe(5);
    expect(pts({ organicLabel: "low" })).toBe(15);
    expect(pts({ hasSocials: false })).toBe(10);
    expect(pts({ priceChange24h: -51 })).toBe(10);
    expect(pts({ priceChange24h: -50 })).toBe(0);
    expect(pts({ metadataMutable: true })).toBe(5);
    expect(pts({ lpBurnPct: null, liquidityUsd: 40000 })).toBe(5);
    expect(pts({ lpBurnPct: null, liquidityUsd: 60000 })).toBe(0);
  });
});

describe("bands", () => {
  // all weights are multiples of 5, so 31 and 61 are unreachable; 30/35 and 60/65 bracket the edges
  const dev = { devPct: 11 }; // 25
  it.each([
    [{ ...dev, metadataMutable: true }, 30, "Green"],
    [{ ...dev, hasSocials: false }, 35, "Yellow"],
    [{ ...dev, top10Pct: 51, hasSocials: false, organicLabel: "medium" }, 60, "Yellow"],
    [{ ...dev, top10Pct: 51, hasSocials: false, organicLabel: "medium", metadataMutable: true }, 65, "Red"],
  ] as [Partial<Signals>, number, string][])("%j -> %i %s", (o, pts, v) => {
    const r = run(o);
    expect([r.score, r.verdict]).toEqual([pts, v]);
  });
});

describe("unknown / notChecked", () => {
  it("unknown downgrades Green to Yellow with incomplete_data", () => {
    const r = run({}, ["solanatracker"]);
    expect(r.verdict).toBe("Yellow");
    expect(r.flags.map((f) => f.id)).toContain("incomplete_data");
  });
  it("unknown never lifts Red", () => expect(run({ mintAuthority: true }, ["goplus"]).verdict).toBe("Red"));
  it("all-null signals with unknown is never Green", () => {
    const nulls = Object.fromEntries(Object.keys(clean).map((k) => [k, null])) as unknown as Signals;
    expect(score(nulls, { unknown: ["goplus", "jupiter", "dexscreener"] }).verdict).toBe("Yellow");
  });
  it("notChecked is not a parameter and costs nothing", () => {
    expect(run({ snipersPct: null, insidersPct: null, bundlersPct: null }).verdict).toBe("Green");
  });
});

describe("fixture back-test", () => {
  const dir = join(__dirname, "fixtures/tokens");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  it("every fixture matches its label", () => {
    const misses: string[] = [];
    for (const file of files) {
      const fx = JSON.parse(readFileSync(join(dir, file), "utf8"));
      const raw: Raw = { goplus: fx.goplus, jupiter: fx.jupiter, dexscreener: fx.dexscreener, tracker: fx.tracker };
      const unknown = Object.values(raw).flatMap((r) => (r && !r.ok ? ["x"] : []));
      const r = score(toSignals(raw), { unknown });
      const want = fx.label[0].toUpperCase() + fx.label.slice(1);
      if (r.verdict !== want) misses.push(`${file}\twant ${want}\tgot ${r.verdict} (${r.score})\t${r.flags.map((f) => f.id).join(",")}`);
    }
    if (misses.length) console.log(`MISSES\n${misses.join("\n")}`);
    expect(files.length).toBeGreaterThanOrEqual(15);
    expect(misses).toEqual([]);
  });
});
