import { describe, expect, it } from "vitest";
import { dueRecaps } from "../src/narratives/schedule";

const at = (h: number, m = 5) => new Date(Date.UTC(2026, 9, 31, h, m));
describe("dueRecaps", () => {
  it("fires sessions only at UTC 0, 8, 16, 21", () => {
    const want: Record<number, string> = { 0: "24h", 8: "asia", 16: "europe", 21: "us" };
    for (let h = 0; h < 24; h++) expect(dueRecaps(at(h))).toEqual(want[h] ? ["hourly", want[h]] : ["hourly"]);
  });
  it("08:05 gives hourly+asia, 09:05 hourly only, late cron at :40 still counts", () => {
    expect(dueRecaps(at(8))).toEqual(["hourly", "asia"]);
    expect(dueRecaps(at(9))).toEqual(["hourly"]);
    expect(dueRecaps(at(8, 40))).toEqual(["hourly", "asia"]);
  });
});
