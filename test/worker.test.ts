import { describe, expect, it, vi } from "vitest";
import { type Deps, type Env, handleFetch } from "../src/worker";

function mk() {
  const store = new Map<string, string>();
  const fetch = vi.fn(async () => new Response("{}", { status: 404 }));
  const deps: Deps = {
    fetch: fetch as unknown as typeof globalThis.fetch,
    kv: {
      get: async (k) => store.get(k) ?? null,
      put: async (k, v) => void store.set(k, v),
      list: async ({ prefix }) => ({ keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
    },
    now: () => new Date("2026-10-31T08:05:00Z"),
  };
  const env = { ASSETS: { fetch: async () => new Response("asset") } } as unknown as Env;
  return { store, fetch, deps, env };
}
const get = (t: ReturnType<typeof mk>, path: string) => handleFetch(new Request(`https://x${path}`), t.env, t.deps);

describe("routes", () => {
  it("invalid mint is 400 with zero fetches", async () => {
    const t = mk();
    const r = await get(t, "/api/analyze/not-a-mint");
    expect(r.status).toBe(400);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(t.fetch).not.toHaveBeenCalled();
  });
  it("unknown recap kind is 400", async () => {
    expect((await get(mk(), "/api/recaps?kind=weekly")).status).toBe(400);
  });
  it("recaps newest first, limited", async () => {
    const t = mk();
    for (const h of ["01", "02", "03"]) t.store.set(`recap:hourly:2026-10-31T${h}:05:00.000Z`, JSON.stringify({ at: h }));
    t.store.set("recap:24h:2026-10-31T00:05:00.000Z", JSON.stringify({ at: "x" }));
    expect(await (await get(t, "/api/recaps?kind=hourly&limit=2")).json()).toEqual([{ at: "03" }, { at: "02" }]);
  });
  it("running defaults to empty tokens", async () => {
    const t = mk();
    expect(await (await get(t, "/api/running")).json()).toEqual({ tokens: [] });
    t.store.set("running:latest", '{"tokens":[1]}');
    expect(await (await get(t, "/api/running")).json()).toEqual({ tokens: [1] });
  });
  it("best-calls returns a list", async () => {
    expect(await (await get(mk(), "/api/best-calls")).json()).toEqual([]);
  });
  it("unknown api path 404, other paths fall through to assets", async () => {
    const t = mk();
    expect((await get(t, "/api/nope")).status).toBe(404);
    expect(await (await get(t, "/")).text()).toBe("asset");
  });
});
