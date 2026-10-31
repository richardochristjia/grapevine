import { analyze, isValidMint } from "./analyze/analyze";
import { bestCalls } from "./narratives/calls";
import { runHourly } from "./narratives/hourly";
import type { RecapKind } from "./narratives/schedule";

export interface Env {
  KV: KVNamespace;
  ASSETS: Fetcher;
  SOLANA_TRACKER_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  list(opts: { prefix: string }): Promise<{ keys: { name: string }[] }>;
}

export interface CacheLike {
  match(req: string): Promise<Response | undefined>;
  put(req: string, res: Response): Promise<void>;
}

export interface Deps {
  fetch: typeof fetch;
  kv: KVLike;
  now: () => Date;
  cache?: CacheLike;
}

export function makeDeps(env: Env): Deps {
  return {
    fetch: (...a) => fetch(...a),
    kv: env.KV,
    now: () => new Date(),
    cache: caches.default,
  };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const KINDS = new Set<string>(["hourly", "24h", "asia", "europe", "us"] satisfies RecapKind[]);

export async function handleFetch(req: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  try {
    const m = pathname.match(/^\/api\/analyze\/([^/]+)$/);
    if (m) {
      if (!isValidMint(m[1])) return json({ error: "invalid mint" }, 400);
      return json(await analyze(m[1], deps, { withTracker: true, trackerKey: env.SOLANA_TRACKER_KEY }));
    }
    if (pathname === "/api/recaps") {
      const kind = url.searchParams.get("kind") ?? "hourly";
      if (!KINDS.has(kind)) return json({ error: "unknown kind" }, 400);
      const n = Number(url.searchParams.get("limit") ?? 24);
      const limit = Math.min(48, Math.max(1, Number.isFinite(n) ? Math.floor(n) : 24));
      const { keys } = await deps.kv.list({ prefix: `recap:${kind}:` });
      const names = keys.map((k) => k.name).sort().reverse().slice(0, limit);
      const vals = await Promise.all(names.map((k) => deps.kv.get(k)));
      return json(vals.flatMap((v) => (v ? [JSON.parse(v)] : [])));
    }
    if (pathname === "/api/running") return json(JSON.parse((await deps.kv.get("running:latest")) ?? '{"tokens":[]}'));
    if (pathname === "/api/best-calls") return json(await bestCalls(deps));
  } catch {
    return json({ error: "internal error" }, 500);
  }
  return json({ error: "not found" }, 404);
}

export async function handleScheduled(ev: { scheduledTime: number }, env: Env, deps: Deps): Promise<void> {
  await runHourly(deps, new Date(ev.scheduledTime), { anthropicKey: env.ANTHROPIC_API_KEY });
}

export default {
  fetch: (req: Request, env: Env) => handleFetch(req, env, makeDeps(env)),
  scheduled: (ev: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(handleScheduled(ev, env, makeDeps(env)));
  },
} satisfies ExportedHandler<Env>;
