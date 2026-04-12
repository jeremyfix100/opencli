export type CrawlSchedulingOptions = {
  concurrency: number;
  minIntervalMs: number;
  intervalJitterMs: number;
  afterEachMs: number;
  afterEachJitterMs: number;
  cooldownEvery: number;
  cooldownMinMs: number;
  cooldownJitterMs: number;
  maxRetries: number;
  retryBaseMs: number;
  retryJitterMs: number;
  randomSeed: number;
};

function clampInt(v: unknown, d: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function normalizeCrawlSchedulingOptions(
  input: Record<string, unknown> | null | undefined,
  defaults: Partial<CrawlSchedulingOptions> = {},
): CrawlSchedulingOptions {
  const obj = (input ?? {}) as Record<string, unknown>;
  const seed = obj.random_seed ?? obj.randomSeed ?? defaults.randomSeed ?? Date.now();
  const seedNum = typeof seed === 'number' ? seed : Number(seed);

  return {
    concurrency: clampInt(obj.concurrency, defaults.concurrency ?? 2, 1, 8),
    minIntervalMs: clampInt(obj.min_interval_ms, defaults.minIntervalMs ?? 1800, 0, 120000),
    intervalJitterMs: clampInt(obj.interval_jitter_ms, defaults.intervalJitterMs ?? 1200, 0, 120000),
    afterEachMs: clampInt(obj.after_each_ms, defaults.afterEachMs ?? 800, 0, 120000),
    afterEachJitterMs: clampInt(obj.after_each_jitter_ms, defaults.afterEachJitterMs ?? 1200, 0, 120000),
    cooldownEvery: clampInt(obj.cooldown_every, defaults.cooldownEvery ?? 10, 0, 100000),
    cooldownMinMs: clampInt(obj.cooldown_min_ms, defaults.cooldownMinMs ?? 5000, 0, 120000),
    cooldownJitterMs: clampInt(obj.cooldown_jitter_ms, defaults.cooldownJitterMs ?? 10000, 0, 120000),
    maxRetries: clampInt(obj.max_retries, defaults.maxRetries ?? 2, 0, 5),
    retryBaseMs: clampInt(obj.retry_base_ms, defaults.retryBaseMs ?? 2000, 0, 120000),
    retryJitterMs: clampInt(obj.retry_jitter_ms, defaults.retryJitterMs ?? 1000, 0, 120000),
    randomSeed: clampInt(seedNum, Number.isFinite(seedNum) ? seedNum : Date.now(), 0, 2_147_483_647),
  };
}

export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function jitterMs(rng: () => number, maxJitterMs: number): number {
  if (maxJitterMs <= 0) return 0;
  return Math.floor(rng() * (maxJitterMs + 1));
}

export async function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((r) => setTimeout(r, ms));
}

export function backoffMs(opts: CrawlSchedulingOptions, attempt: number, rng: () => number): number {
  const k = Math.max(1, attempt);
  const base = opts.retryBaseMs * Math.pow(2, k - 1);
  return Math.min(120000, Math.floor(base + jitterMs(rng, opts.retryJitterMs)));
}

export function createStartGate(opts: CrawlSchedulingOptions, rng: () => number): { waitTurn: () => Promise<void> } {
  let nextAllowedAt = 0;
  let chain = Promise.resolve();
  const waitTurn = () => {
    const p = chain.then(async () => {
      const now = Date.now();
      const j = jitterMs(rng, opts.intervalJitterMs);
      const startAt = Math.max(now, nextAllowedAt);
      const wait = Math.max(0, startAt - now);
      nextAllowedAt = startAt + opts.minIntervalMs + j;
      await sleepMs(wait);
    });
    chain = p.catch(() => undefined);
    return p;
  };
  return { waitTurn };
}

export function createCooldownGate(
  opts: CrawlSchedulingOptions,
  rng: () => number,
): { maybeCooldown: (doneCount: number) => Promise<void> } {
  let chain = Promise.resolve();
  const maybeCooldown = (doneCount: number) => {
    if (opts.cooldownEvery <= 0) return Promise.resolve();
    if (doneCount <= 0 || doneCount % opts.cooldownEvery !== 0) return Promise.resolve();
    const ms = opts.cooldownMinMs + jitterMs(rng, opts.cooldownJitterMs);
    const p = chain.then(() => sleepMs(ms));
    chain = p.catch(() => undefined);
    return p;
  };
  return { maybeCooldown };
}

