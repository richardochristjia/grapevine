import { analyze } from "../analyze/analyze";
import type { Deps } from "../worker";
import { mergeCalls, TTL } from "./calls";
import { collect } from "./collect";
import { type Recap, type RecapData, writeRecap } from "./recap";
import { dueRecaps, WINDOW_HOURS } from "./schedule";

const CONCURRENCY = 5;

async function pool<T, R>(items: T[], fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (i < items.length) {
        const n = i++;
        out[n] = await fn(items[n]);
      }
    }),
  );
  return out;
}

// Last 24 hourly recaps in one key: session recaps read 1 key instead of up to 24 (Workers Free allows 50 subrequests per run).
const RECENT = "recent:hourly"; // outside the recap:hourly: prefix that /api/recaps lists
type Recent = { at: string; text: string }[];

async function pushRecent(deps: Deps, r: Recap): Promise<Recent> {
  const prev: Recent = JSON.parse((await deps.kv.get(RECENT)) ?? "[]");
  const recent = [...prev, { at: r.at, text: r.text }].slice(-24);
  await deps.kv.put(RECENT, JSON.stringify(recent), { expirationTtl: TTL });
  return recent;
}

export async function runHourly(deps: Deps, scheduledTime: Date, opts: { anthropicKey?: string } = {}): Promise<Recap[]> {
  const c = await collect(deps);
  const verdicts = await pool(c.tokens, async (t) => {
    try {
      return (await analyze(t.mint, deps, { withTracker: false })).verdict as string;
    } catch {
      return "unknown";
    }
  });
  const tokens = c.tokens.map((t, i) => ({ ...t, verdict: verdicts[i] }));
  await mergeCalls(deps, c.tokens);
  await deps.kv.put("running:latest", JSON.stringify({ at: scheduledTime.toISOString(), tokens }), { expirationTtl: TTL });

  const data: RecapData = { tokens, themes: c.themes, casts: c.casts, cashtags: c.cashtags };
  const out: Recap[] = [];
  let recent: Recent = [];
  for (const kind of dueRecaps(scheduledTime)) { // dueRecaps lists "hourly" first
    if (kind === "hourly") {
      const r = await writeRecap(deps, kind, scheduledTime, data, opts.anthropicKey);
      recent = await pushRecent(deps, r);
      out.push(r);
      continue;
    }
    const until = scheduledTime.getTime(), since = until - WINDOW_HOURS[kind] * 3600000;
    const hourlyTexts = recent.filter((x) => Date.parse(x.at) > since && Date.parse(x.at) <= until).map((x) => x.text);
    out.push(await writeRecap(deps, kind, scheduledTime, { ...data, hourlyTexts }, opts.anthropicKey));
  }
  return out;
}
