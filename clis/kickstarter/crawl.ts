import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuthRequiredError, EmptyResultError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import type { IPage } from '@jackwener/opencli/types';
import {
  backoffMs,
  createCooldownGate,
  createStartGate,
  jitterMs,
  mulberry32,
  normalizeCrawlSchedulingOptions,
  sleepMs,
} from '../_shared/crawl-scheduling.js';

const DOMAIN = 'www.kickstarter.com';
const BASE_URL = 'https://www.kickstarter.com';
const DEFAULT_SEARCH_URL = BASE_URL + '/discover/advanced?sort=popularity';
const MAX_LIMIT = 200;
const DEFAULT_DETAIL_TIMEOUT_MS = 45_000;
const LIST_COLLECTION_MAX_MS = 600_000;
const LIST_COLLECTION_MAX_ROUNDS = 120;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function nowIsoUtc8(): string {
  const d = new Date();
  const shifted = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const Y = shifted.getUTCFullYear();
  const M = pad2(shifted.getUTCMonth() + 1);
  const D = pad2(shifted.getUTCDate());
  const h = pad2(shifted.getUTCHours());
  const m = pad2(shifted.getUTCMinutes());
  const s = pad2(shifted.getUTCSeconds());
  const ms = pad3(shifted.getUTCMilliseconds());
  return `${Y}-${M}-${D}T${h}:${m}:${s}.${ms}+08:00`;
}

function makeRunId(): string {
  return 'ks_' + nowIsoUtc8().replace(/[:.]/g, '-');
}

function normalizeLimit(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 20;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

function resolveSearchUrl(input: unknown): string {
  const raw = String(input ?? '').trim();
  if (!raw) return DEFAULT_SEARCH_URL;
  if (/^https?:\/\//i.test(raw)) return raw;
  return BASE_URL + '/discover/advanced?term=' + encodeURIComponent(raw) + '&sort=popularity';
}

function parseListPageNumber(url: string): number {
  try {
    const u = new URL(url);
    const raw = u.searchParams.get('page');
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isFinite(n) || n <= 0) return 1;
    return n;
  } catch {
    return 1;
  }
}

function withListPageNumber(url: string, pageNumber: number): string {
  const n = Math.max(1, Math.floor(pageNumber));
  try {
    const u = new URL(url);
    u.searchParams.set('page', String(n));
    return u.toString();
  } catch {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}page=${encodeURIComponent(String(n))}`;
  }
}

function shouldAdvanceListPage(input: {
  domItemCount: number;
  newCount: number;
  clickedLoadMore: boolean;
  seenOnCurrentPage: number;
  roundsWithoutNew: number;
}): boolean {
  if (input.clickedLoadMore) return false;
  if (input.newCount > 0) return false;
  if (input.domItemCount <= 0) return input.roundsWithoutNew >= 2;
  if (input.seenOnCurrentPage >= input.domItemCount) return true;
  return input.roundsWithoutNew >= 5;
}

function toAbsoluteUrl(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith('//')) return 'https:' + raw;
  try {
    const parsed = new URL(raw, BASE_URL);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function toAbsoluteProjectUrl(value: string): string {
  const raw = String(value ?? '').trim();
  const u = new URL(raw, BASE_URL);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('invalid url');
  return u.toString();
}

function rawIdFromKickstarterUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const idx = parts.indexOf('projects');
    if (idx < 0) return null;
    const creator = parts[idx + 1];
    const slug = parts[idx + 2];
    if (!creator || !slug) return null;
    return `${creator}/${slug}`;
  } catch {
    return null;
  }
}

function getLlmConfigFromEnv():
  | {
      endpoint: string;
      apiKey: string;
      model: string;
      timeoutMs?: number;
    }
  | null {
  const endpoint = process.env.MKT_CRAWLER_LLM_ENDPOINT?.trim();
  const apiKey = process.env.MKT_CRAWLER_LLM_API_KEY?.trim();
  const model = process.env.MKT_CRAWLER_LLM_MODEL?.trim();
  if (!endpoint || !apiKey || !model) return null;
  const timeoutRaw =
    process.env.OPENCLI_MKT_CRAWLER_LLM_TIMEOUT_MS?.trim() ??
    process.env.MKT_CRAWLER_LLM_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
  return {
    endpoint,
    apiKey,
    model,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
  };
}

function getArtifactsBaseDir(): string | null {
  const dir = process.env.OPENCLI_LEARNING_ARTIFACTS_DIR?.trim();
  return dir ? dir : null;
}

function getLearningModeFromEnv(): 'auto' | 'llm_only' | 'heuristic_only' | 'cache_only' | undefined {
  const raw = process.env.OPENCLI_KICKSTARTER_LEARNING_MODE?.trim();
  if (!raw) return undefined;
  if (raw === 'auto' || raw === 'llm_only' || raw === 'heuristic_only' || raw === 'cache_only') return raw;
  return undefined;
}

function shouldSaveHtmlSnapshots(learningMode: ReturnType<typeof getLearningModeFromEnv>): boolean {
  const override = process.env.OPENCLI_SAVE_HTML_SNAPSHOTS?.trim();
  if (override === '1') return true;
  if (override === '0') return false;
  return learningMode !== 'cache_only';
}

function getKickstarterSchemaRegistryPath(): string {
  const overridden = process.env.OPENCLI_KICKSTARTER_SCHEMA_REGISTRY_PATH?.trim();
  if (overridden) return overridden;
  return path.join(os.homedir(), '.opencli', 'kickstarter-core-schema.json');
}

function getSchemaHintPromptFromEnv(): string | undefined {
  const raw = process.env.OPENCLI_KICKSTARTER_SCHEMA_HINT_PROMPT?.trim();
  return raw ? raw : undefined;
}

function getRuleCacheFilePath(): string {
  const overridden = process.env.OPENCLI_KICKSTARTER_RULE_CACHE_PATH?.trim();
  if (overridden) return overridden;
  return path.join(os.homedir(), '.opencli', 'kickstarter-rule-cache.json');
}

function getDetailTimeoutMsFromEnv(): number {
  const raw = process.env.OPENCLI_KICKSTARTER_DETAIL_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_DETAIL_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DETAIL_TIMEOUT_MS;
  return Math.floor(n);
}

async function withTimeoutMs<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } finally {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

type KickstarterListEvalPayload = {
  authRequired?: boolean;
  items?: Array<Record<string, unknown>>;
  hasLoadMore?: boolean;
};

async function evalKickstarterList(page: IPage): Promise<KickstarterListEvalPayload> {
  return (await page.evaluate(`
    (function () {
      function clean(v) { return String(v || '').replace(/\\s+/g, ' ').trim(); }
      function firstText(root, selectors) {
        for (var i = 0; i < selectors.length; i++) {
          var el = root && root.querySelector ? root.querySelector(selectors[i]) : null;
          if (el && el.textContent) return clean(el.textContent);
        }
        return '';
      }

      var body = document.body;
      var bodyText = clean(body && body.innerText ? body.innerText : '');
      var authRequired = /log in|sign in|please sign in|please log in|captcha|verify|verification|risk|风控|登录|验证/i.test(bodyText);

      var cards = document.querySelectorAll('a[href*=\"/projects/\"]');
      var dedupe = Object.create(null);
      var items = [];

      for (var i = 0; i < cards.length; i++) {
        var anchor = cards[i];
        var href = (anchor.getAttribute && anchor.getAttribute('href')) || '';
        var url = anchor.href || href || '';
        var key = url || href;
        if (!key || dedupe[key]) continue;
        dedupe[key] = true;

        var card = (anchor.closest && anchor.closest('article, li, div')) || anchor;
        var title = clean(
          (anchor.getAttribute && anchor.getAttribute('title'))
            || firstText(anchor, ['h1', 'h2', 'h3', 'h4'])
            || anchor.textContent
        );
        var rawMatch = url.match(/\\/projects\\/([^/?#]+\\/[^/?#]+)/) || url.match(/\\/projects\\/([^/?#]+)/);
        var rawId = rawMatch ? clean(rawMatch[1]) : '';

        if (!title && !url) continue;
        items.push({ title: title || null, url: url || null, raw_id: rawId || null });
      }

      function hasLoadMore() {
        var nodes = document.querySelectorAll('button,[role=\"button\"],a[role=\"button\"]');
        for (var i = 0; i < nodes.length; i++) {
          var el = nodes[i];
          var t = clean(el && el.textContent ? el.textContent : '');
          if (!t) continue;
          if (/load\\s*more|more\\s*projects|載入更多|加载更多|更多/i.test(t)) return true;
        }
        return false;
      }

      return { authRequired: authRequired, items: items, hasLoadMore: hasLoadMore() };
    })()
  `)) as KickstarterListEvalPayload;
}

async function clickKickstarterLoadMore(page: IPage): Promise<boolean> {
  const res = (await page.evaluate(`
    (function () {
      function clean(v) { return String(v || '').replace(/\\s+/g, ' ').trim(); }
      function isDisabled(el) {
        try { return Boolean(el && (el.disabled || el.getAttribute('aria-disabled') === 'true')); } catch (e) { return false; }
      }
      var nodes = document.querySelectorAll('button,[role=\"button\"],a[role=\"button\"]');
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var t = clean(el && el.textContent ? el.textContent : '');
        if (!t) continue;
        if (!/load\\s*more|more\\s*projects|載入更多|加载更多|更多/i.test(t)) continue;
        if (isDisabled(el)) continue;
        try { el.click(); return true; } catch (e) { /* continue */ }
      }
      return false;
    })()
  `)) as unknown;
  return Boolean(res);
}

type ExecPayload = {
  values: Record<string, unknown>;
  provenance?: Record<string, unknown>;
};

type ExtractionWarning = {
  flagged: boolean;
  codes: string[];
  message: string | null;
};

function isNonEmptyValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function buildExtractionWarning(input: {
  snapshotSummaries?: Record<string, { text_len?: number | null } | null | undefined> | null;
  values: Record<string, unknown>;
  selectorPlan?: { plans?: Array<{ field?: unknown }> } | null;
  listTitle?: string | null;
}): ExtractionWarning {
  const codes: string[] = [];
  const summaries = input.snapshotSummaries ? Object.values(input.snapshotSummaries) : [];
  const maxTextLen = summaries.reduce((max, row) => {
    const n = Number(row?.text_len ?? 0);
    return Number.isFinite(n) ? Math.max(max, n) : max;
  }, 0);
  if (maxTextLen > 0 && maxTextLen < 1200) {
    codes.push('low_visible_text');
  }

  const nonCoreExtractedCount = Object.entries(input.values).filter(([field, value]) => {
    if (field === 'title' || field === 'url' || field === 'raw_id') return false;
    return isNonEmptyValue(value);
  }).length;
  if (nonCoreExtractedCount === 0) {
    codes.push('no_detail_fields_extracted');
  }

  const selectorFields = Array.isArray(input.selectorPlan?.plans)
    ? input.selectorPlan!.plans.map((plan) => String(plan?.field ?? '')).filter(Boolean)
    : [];
  const matchedFields = Object.entries(input.values).filter(([, value]) => isNonEmptyValue(value)).map(([field]) => field);
  if (selectorFields.length > 0 && matchedFields.length <= 2) {
    codes.push('very_sparse_selector_matches');
  }

  const extractedTitle = typeof input.values.title === 'string' ? input.values.title.trim() : '';
  const listTitle = typeof input.listTitle === 'string' ? input.listTitle.trim() : '';
  if (!extractedTitle && listTitle) {
    codes.push('title_from_list_fallback');
  }

  const uniqueCodes = Array.from(new Set(codes));
  return {
    flagged: uniqueCodes.length > 0,
    codes: uniqueCodes,
    message: uniqueCodes.length > 0 ? `Suspicious extraction: ${uniqueCodes.join(', ')}` : null,
  };
}

async function autoScrollKickstarterList(page: IPage, opts?: { times?: number; delayMs?: number }): Promise<void> {
  const times = Math.max(1, Math.min(8, Math.floor(opts?.times ?? 4)));
  const delayMs = Math.max(250, Math.min(4000, Math.floor(opts?.delayMs ?? 1500)));
  await page.evaluate(`
    (async () => {
      function isScrollable(el) {
        if (!el || el === document.body || el === document.documentElement) return false;
        try {
          const style = window.getComputedStyle(el);
          const oy = style.overflowY || '';
          if (!/(auto|scroll)/i.test(oy)) return false;
        } catch {}
        try {
          return (el.scrollHeight - el.clientHeight) > 300;
        } catch {
          return false;
        }
      }

      function pickScrollContainer() {
        const candidates = [];
        const all = Array.from(document.querySelectorAll('main, [role="main"], section, div'));
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          if (!isScrollable(el)) continue;
          const score = Math.min(50000, (el.scrollHeight - el.clientHeight)) + Math.min(10000, el.clientHeight);
          candidates.push({ el, score });
        }
        candidates.sort((a, b) => b.score - a.score);
        return candidates[0]?.el || null;
      }

      async function waitForDomChange(timeoutMs) {
        await new Promise(resolve => {
          if (!document.body) return resolve(null);
          let done = false;
          const finish = () => { if (done) return; done = true; try { obs.disconnect(); } catch {} resolve(null); };
          const obs = new MutationObserver(() => finish());
          try { obs.observe(document.body, { childList: true, subtree: true, attributes: true }); } catch {}
          setTimeout(finish, timeoutMs);
        });
      }

      const scrollingEl = document.scrollingElement || document.documentElement;
      for (let i = 0; i < ${times}; i++) {
        const container = pickScrollContainer();
        try {
          if (container) container.scrollTop = container.scrollHeight;
        } catch {}
        try {
          if (scrollingEl) scrollingEl.scrollTop = scrollingEl.scrollHeight;
        } catch {}
        try {
          window.scrollTo(0, Math.max(document.body ? document.body.scrollHeight : 0, 10_000_000));
        } catch {}
        await waitForDomChange(${delayMs});
      }
    })()
  `);
}

async function safeWriteJson(
  engine: typeof import('mkt-learning-engine'),
  filePath: string,
  payload: unknown,
): Promise<void> {
  try {
    await engine.writeArtifactJson(filePath, payload);
  } catch {
    // Must never break crawl path
  }
}

async function safeAppendTrace(
  engine: typeof import('mkt-learning-engine'),
  filePath: string,
  record: ReturnType<(typeof import('mkt-learning-engine'))['createEngineTraceEvent']>,
): Promise<void> {
  try {
    await engine.appendEngineTraceEvent(filePath, record);
  } catch {
    // Must never break crawl path
  }
}

async function safeWriteText(filePath: string, content: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
  } catch {
    // Must never break crawl path
  }
}

cli({
  site: 'kickstarter',
  name: 'crawl',
  description: 'Kickstarter list -> project detail crawl (schema-first, cache-first)',
  domain: DOMAIN,
  // Keep discover/list crawl usable without requiring a logged-in Chrome session.
  // We still detect and surface auth/risk blocks via page content heuristics.
  strategy: Strategy.PUBLIC,
  browser: true,
  timeoutSeconds: 30 * 60,
  args: [
    {
      name: 'query_or_url',
      positional: true,
      required: false,
      help: 'Search keyword or full Kickstarter discover URL',
    },
    { name: 'limit', type: 'int', default: 10, help: 'Number of projects to crawl (max 200)' },
    { name: 'concurrency', type: 'int', default: 2, help: 'Scheduling: logical concurrency knob (default 2)' },
    { name: 'min_interval_ms', type: 'int', default: 1800, help: 'Scheduling: min interval before starting each detail' },
    { name: 'interval_jitter_ms', type: 'int', default: 1200, help: 'Scheduling: random jitter for start interval' },
    { name: 'after_each_ms', type: 'int', default: 800, help: 'Scheduling: base sleep after each detail' },
    { name: 'after_each_jitter_ms', type: 'int', default: 1200, help: 'Scheduling: random jitter after each detail' },
    { name: 'cooldown_every', type: 'int', default: 10, help: 'Scheduling: cooldown every N details (0 disables)' },
    { name: 'cooldown_min_ms', type: 'int', default: 5000, help: 'Scheduling: base cooldown duration' },
    { name: 'cooldown_jitter_ms', type: 'int', default: 10000, help: 'Scheduling: cooldown jitter' },
    { name: 'max_retries', type: 'int', default: 2, help: 'Scheduling: max retries for recoverable errors' },
    { name: 'retry_base_ms', type: 'int', default: 2000, help: 'Scheduling: retry backoff base' },
    { name: 'retry_jitter_ms', type: 'int', default: 1000, help: 'Scheduling: retry backoff jitter' },
    { name: 'random_seed', type: 'int', required: false, help: 'Scheduling: random seed for jitter (optional)' },
  ],
  columns: ['title', 'url', 'raw_id'],
  func: async (page: IPage, kwargs) => {
    const engine = await import('mkt-learning-engine');
    const artifactsBaseDir = getArtifactsBaseDir();
    const runId = artifactsBaseDir ? makeRunId() : null;
    const runRoot =
      artifactsBaseDir && runId ? path.join(artifactsBaseDir, 'artifacts', 'kickstarter', runId) : null;

    const limit = normalizeLimit(kwargs.limit);
    const listUrl = resolveSearchUrl(kwargs.query_or_url);
    let currentListUrl = listUrl;
    let currentListPageNo = parseListPageNumber(currentListUrl);

    const sched = normalizeCrawlSchedulingOptions(kwargs as any);
    const rng = mulberry32(sched.randomSeed);
    const startGate = createStartGate(sched, rng);
    const cooldownGate = createCooldownGate(sched, rng);
    if (runRoot) {
      await safeWriteJson(engine, path.join(runRoot, 'scheduling.json'), {
        ts: nowIsoUtc8(),
        site: 'kickstarter',
        command: 'crawl',
        scheduling: sched,
      });
    }

    await page.goto(currentListUrl);
    try {
      await page.wait(2);
    } catch {
      // Best effort only
    }

    const seenUrlKeys = new Set<string>();
    const targetItems: Array<{ title: string | null; url: string | null; raw_id: string | null }> = [];
    const debugRounds: Array<Record<string, unknown>> = [];
    const debugPagesVisited: Array<{ ts: string; url: string; page: number }> = [{ ts: nowIsoUtc8(), url: currentListUrl, page: currentListPageNo }];
    let authRequiredDetected = false;
    let roundsWithoutNew = 0;
    let seenOnCurrentPage = 0;
    const startedListAt = Date.now();
    let listStopReason: string | null = null;

    for (let round = 0; round < LIST_COLLECTION_MAX_ROUNDS && seenUrlKeys.size < limit; round += 1) {
      const listPayload = (await page.evaluate(`
        (function () {
          function clean(v) { return String(v || '').replace(/\\s+/g, ' ').trim(); }
          function firstText(root, selectors) {
            for (var i = 0; i < selectors.length; i++) {
              var el = root && root.querySelector ? root.querySelector(selectors[i]) : null;
              if (el && el.textContent) return clean(el.textContent);
            }
            return '';
          }
          function firstAttr(root, selectors, attr) {
            for (var i = 0; i < selectors.length; i++) {
              var el = root && root.querySelector ? root.querySelector(selectors[i]) : null;
              if (!el) continue;
              var v = el.getAttribute ? el.getAttribute(attr) : '';
              if (v) return clean(v);
            }
            return '';
          }
          function findLoadMoreButton() {
            try {
              var btns = document.querySelectorAll('button, a[role=\"button\"]');
              for (var i = 0; i < btns.length; i++) {
                var b = btns[i];
                if (!b) continue;
                var text = clean(b.textContent || '');
                var aria = clean((b.getAttribute && (b.getAttribute('aria-label') || b.getAttribute('title'))) || '');
                var label = (text + ' ' + aria).trim();
                if (!label) continue;
                if (!/load more|show more|more projects|more results|see more|next/i.test(label)) continue;
                var disabled = false;
                try { disabled = !!(b.disabled || b.getAttribute('aria-disabled') === 'true'); } catch {}
                if (disabled) continue;
                return b;
              }
              return null;
            } catch (e) {
              return null;
            }
          }

          var body = document.body;
          var bodyText = clean(body && body.innerText ? body.innerText : '');
          var authRequired = /log in|sign in|please sign in|please log in|captcha|verify|verification|risk|风控|登录|验证/i.test(bodyText);

          var cards = document.querySelectorAll('a[href*=\"/projects/\"]');
          var dedupe = Object.create(null);
          var items = [];

          for (var i = 0; i < cards.length; i++) {
            var anchor = cards[i];
            var href = (anchor.getAttribute && anchor.getAttribute('href')) || '';
            var url = anchor.href || href || '';
            var key = url || href;
            if (!key || dedupe[key]) continue;
            dedupe[key] = true;

            var card = (anchor.closest && anchor.closest('article, li, div')) || anchor;
            var title = clean(
              (anchor.getAttribute && anchor.getAttribute('title'))
                || firstText(anchor, ['h1', 'h2', 'h3', 'h4'])
                || anchor.textContent
            );
            var rawMatch = url.match(/\\/projects\\/([^/?#]+\\/[^/?#]+)/) || url.match(/\\/projects\\/([^/?#]+)/);
            var rawId = rawMatch ? clean(rawMatch[1]) : '';

            if (!title && !url) continue;
            items.push({ title: title || null, url: url || null, raw_id: rawId || null });
          }

          var clicked = false;
          var btn = findLoadMoreButton();
          if (btn) {
            try { btn.scrollIntoView({ block: 'center' }); } catch {}
            try {
              btn.click();
              clicked = true;
            } catch (e) {
              try {
                var ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
                btn.dispatchEvent(ev);
                clicked = true;
              } catch {}
            }
          }

          return {
            authRequired: authRequired,
            itemCount: items.length,
            clickedLoadMore: clicked,
            items: items
          };
        })()
      `)) as {
        authRequired?: boolean;
        itemCount?: number;
        clickedLoadMore?: boolean;
        items?: Array<Record<string, unknown>>;
      };

      authRequiredDetected = authRequiredDetected || Boolean(listPayload?.authRequired);

      const rawItems = Array.isArray(listPayload?.items) ? listPayload.items : [];
      let newCount = 0;
      for (const item of rawItems) {
        const abs = toAbsoluteUrl(item.url);
        if (!abs) continue;
        const key = abs;
        if (seenUrlKeys.has(key)) continue;
        seenUrlKeys.add(key);
        newCount += 1;
        targetItems.push({
          title: typeof item.title === 'string' ? item.title : null,
          url: abs,
          raw_id: item.raw_id == null ? null : String(item.raw_id),
        });
        if (targetItems.length >= limit) break;
      }
      seenOnCurrentPage += newCount;

      debugRounds.push({
        ts: nowIsoUtc8(),
        round,
        list_page: currentListPageNo,
        dom_items: Number(listPayload?.itemCount ?? 0),
        new_items: newCount,
        total_items: targetItems.length,
        clickedLoadMore: Boolean(listPayload?.clickedLoadMore),
      });

      if (newCount === 0) {
        roundsWithoutNew += 1;
      } else {
        roundsWithoutNew = 0;
      }

      if (targetItems.length >= limit) {
        listStopReason = 'limit_reached';
        break;
      }

      try {
        await autoScrollKickstarterList(page, { times: 4, delayMs: 1200 });
      } catch {}

      if (
        shouldAdvanceListPage({
          domItemCount: Number(listPayload?.itemCount ?? 0),
          newCount,
          clickedLoadMore: Boolean(listPayload?.clickedLoadMore),
          seenOnCurrentPage,
          roundsWithoutNew,
        })
      ) {
        const nextPageNo = currentListPageNo + 1;
        const nextUrl = withListPageNumber(currentListUrl, nextPageNo);
        if (nextUrl !== currentListUrl) {
          currentListUrl = nextUrl;
          currentListPageNo = nextPageNo;
          seenOnCurrentPage = 0;
          debugPagesVisited.push({ ts: nowIsoUtc8(), url: currentListUrl, page: currentListPageNo });
          try {
            await page.goto(currentListUrl);
            await page.wait(2);
          } catch {}
          roundsWithoutNew = 0;
          continue;
        }
      }

      if (Date.now() - startedListAt > LIST_COLLECTION_MAX_MS) {
        listStopReason = 'time_budget_exceeded';
        break;
      }

      try {
        await page.autoScroll({ times: 3, delayMs: 1200 });
      } catch {}
      try {
        await page.wait(2);
      } catch {}
    }

    if (!listStopReason) {
      listStopReason =
        targetItems.length >= limit
          ? 'limit_reached'
          : Date.now() - startedListAt > LIST_COLLECTION_MAX_MS
            ? 'time_budget_exceeded'
            : 'round_budget_exceeded';
    }

    if (runRoot) {
      await safeWriteJson(engine, path.join(runRoot, 'list-collection.json'), {
        ts: nowIsoUtc8(),
        listUrl,
        pagesVisited: debugPagesVisited,
        limit,
        authRequiredDetected,
        total: targetItems.length,
        stopReason: listStopReason,
        rounds: debugRounds,
      });
    }

    if (authRequiredDetected && targetItems.length === 0) {
      throw new AuthRequiredError(DOMAIN, 'AuthRequired: kickstarter/crawl requires login or passed verification');
    }
    if (targetItems.length === 0) {
      throw new EmptyResultError('kickstarter/crawl', 'No project URLs found on list page');
    }
    if (targetItems.length < limit) {
      throw new EmptyResultError(
        'kickstarter/crawl',
        `List page yielded only ${targetItems.length}/${limit} unique project URLs (no pagination/scroll match).`,
      );
    }

    const targets = targetItems.slice(0, limit);

    const cacheFilePath = getRuleCacheFilePath();
    const llm = getLlmConfigFromEnv();
    const learning_mode = getLearningModeFromEnv();
    const schemaRegistryFilePath = getKickstarterSchemaRegistryPath();
    const schema_hint_prompt = getSchemaHintPromptFromEnv();

    const pageType = 'project_detail';
    const urlPattern = '/projects/:creator/:slug';

    const rows: Array<Record<string, unknown>> = [];
    const detailTimeoutMs = getDetailTimeoutMsFromEnv();
    const isRecoverable = (e: unknown): boolean => {
      const msg = e instanceof Error ? e.message : String(e);
      if (/authrequired/i.test(msg)) return false;
      if (/captcha|verify|verification|risk|风控|登录|验证/i.test(msg)) return true;
      if (/\b429\b|\b403\b/.test(msg)) return true;
      if (/timeout|timed out|navigation/i.test(msg)) return true;
      if (/blocked/i.test(msg)) return true;
      return false;
    };

    let doneCount = 0;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      const url = toAbsoluteProjectUrl(t.url!);
      const rawIdFallback = rawIdFromKickstarterUrl(url);

      const beforeRowsLen = rows.length;
      let finalError: unknown | null = null;
      for (let attempt = 0; attempt <= sched.maxRetries; attempt += 1) {
        try {
          await startGate.waitTurn();

          const attemptSuffix = attempt > 0 ? `@retry${attempt}` : '';
          const pageKey = `${pageType}:${urlPattern}#${rawIdFallback ?? String(i + 1)}${attemptSuffix}`;
          const artifactPaths =
            artifactsBaseDir && runId
              ? engine.buildLearningArtifactPaths({
                  baseDir: artifactsBaseDir,
                  site: 'kickstarter',
                  runId,
                  pageKey,
                })
              : null;

          let cancelled = false;
          await withTimeoutMs(
            (async () => {
              await page.goto(url);
              if (cancelled) return;
              const s0html = await page.evaluate('document.documentElement.outerHTML');
              if (cancelled) return;
              try {
                await page.wait(1);
              } catch {}
              if (cancelled) return;
              const s1html = await page.evaluate('document.documentElement.outerHTML');
              if (cancelled) return;
              try {
                await page.autoScroll();
              } catch {}
              if (cancelled) return;
              try {
                await page.wait(1);
              } catch {}
              if (cancelled) return;
              const s2html = await page.evaluate('document.documentElement.outerHTML');
              if (cancelled) return;

              const ts = () => nowIsoUtc8();
              const html_snapshots = {
                s0: { ts: ts(), html: typeof s0html === 'string' ? s0html : String(s0html ?? '') },
                s1: { ts: ts(), html: typeof s1html === 'string' ? s1html : String(s1html ?? '') },
                s2: { ts: ts(), html: typeof s2html === 'string' ? s2html : String(s2html ?? '') },
              } as const;
              const htmlSnapshotsSummary = {
                s0: { ts: html_snapshots.s0.ts, byte_len: html_snapshots.s0.html.length },
                s1: { ts: html_snapshots.s1.ts, byte_len: html_snapshots.s1.html.length },
                s2: { ts: html_snapshots.s2.ts, byte_len: html_snapshots.s2.html.length },
              } as const;

	              const saveHtmlSnapshots = Boolean(artifactPaths) && shouldSaveHtmlSnapshots(learning_mode);
	              if (artifactPaths && saveHtmlSnapshots) {
	                const snapshotsDir = path.join(artifactPaths.root, 'snapshots');
	                await safeWriteText(path.join(snapshotsDir, 's0.html'), html_snapshots.s0.html);
	                if (cancelled) return;
	                await safeWriteText(path.join(snapshotsDir, 's1.html'), html_snapshots.s1.html);
	                if (cancelled) return;
	                await safeWriteText(path.join(snapshotsDir, 's2.html'), html_snapshots.s2.html);
	                if (cancelled) return;
	              }
	              if (artifactPaths) {
	                await safeWriteJson(engine, artifactPaths.rawPage, {
	                  site: 'kickstarter',
	                  page_type: pageType,
	                  url,
                  url_pattern: urlPattern,
                  html_snapshots_summary: htmlSnapshotsSummary,
                });
                if (cancelled) return;
                await safeWriteJson(engine, path.join(artifactPaths.root, 'engine-input.json'), {
                  site: 'kickstarter',
                  page_type: pageType,
                  url,
                  url_pattern: urlPattern,
                  schema_version: 'v1',
                  prompt_version: 'page_understanding_v1',
                  cache: { file_path: cacheFilePath },
                  learning_mode: learning_mode ?? null,
                  llm: llm ? { endpoint: llm.endpoint, model: llm.model, timeoutMs: llm.timeoutMs ?? null } : null,
                  schema_first: {
                    enabled: true,
                    schema_registry_file_path: schemaRegistryFilePath,
                    schema_hint_prompt: schema_hint_prompt ?? null,
	                  },
	                  html_snapshots_summary: htmlSnapshotsSummary,
	                  snapshots_saved: saveHtmlSnapshots,
	                  scheduling: sched,
	                  scheduling_seed: sched.randomSeed,
	                  scheduling_attempt: attempt,
	                });
                if (cancelled) return;
              }

              const startedAt = new Date();
              if (cancelled) return;
              let learningRes: Awaited<ReturnType<(typeof engine)['getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1']>>;
              try {
                learningRes = await engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1({
                  schemaRegistryFilePath,
                  selectorCacheFilePath: cacheFilePath,
                  site: 'kickstarter',
                  page_type: pageType,
                  url,
                  url_pattern: urlPattern,
                  schema_version: 'v1',
                  prompt_version: 'page_understanding_v1',
                  ...(schema_hint_prompt !== undefined ? { schema_hint_prompt } : {}),
                  html_snapshots,
                  learning_mode,
                  llm,
                  fetchImpl: fetch,
                });
              } catch (e) {
                const code = typeof (e as any)?.code === 'string' ? String((e as any).code) : undefined;
                if (code === 'schema_cache_miss_requires_learn' || code === 'selector_cache_miss_requires_learn') {
                  throw new Error('需要先 Learn：缓存缺失（core_schema / selector_plan）。请先执行 Learn，再 Run + Persist。');
                }
                throw e;
              }
              if (cancelled) return;

          const anyBlocked =
            learningRes &&
            (learningRes as any).snapshot_summaries &&
            Object.values((learningRes as any).snapshot_summaries as Record<string, any>).some((s) => Boolean(s?.blocked));
          const selectorPlanForEval = learningRes.selector_plan ?? { plans: [] };
          if (cancelled) return;
          if (anyBlocked) {
            if (attempt < sched.maxRetries) {
              const err = new Error('blocked');
              (err as any).code = 'blocked';
              throw err;
            }

            const core: Record<string, unknown> = {
              title: t.title ?? null,
              url,
              raw_id: rawIdFallback,
            };
            const row = {
              site: 'kickstarter',
              page_type: pageType,
              ...core,
              extra: {
                blocked: { value: true, value_type: 'boolean', provenance: { strategy: 'blocked' } },
                error: { value: 'blocked', value_type: 'text', provenance: { strategy: 'blocked' } },
              },
            };
            if (cancelled) return;
            rows.push(row);

            if (cancelled) return;
            if (artifactPaths && runId) {
              const schemaFirstOut = {
                enabled: true,
                schema_registry_file_path: schemaRegistryFilePath,
                schema_hint_prompt: schema_hint_prompt ?? null,
                core_schema: (learningRes as any).core_schema ?? null,
                core_schema_sig: (learningRes as any).core_schema_sig ?? null,
                schema_variant_key: (learningRes as any).schema_variant_key ?? null,
                schema_cache_status: (learningRes as any).schema_cache_status ?? null,
                schema_learning_method: (learningRes as any).schema_learning_method ?? null,
                schema_llm_model: (learningRes as any).schema_llm_model ?? null,
                schema_used_snapshot_key: (learningRes as any).schema_used_snapshot_key ?? null,
                schema_snapshot_summaries: (learningRes as any).schema_snapshot_summaries ?? null,
              };

              await safeWriteJson(engine, path.join(artifactPaths.root, 'engine-output.json'), {
                cache_status: learningRes.cache_status,
                learning_method: (learningRes as any).learning_method ?? null,
                llm_model: (learningRes as any).llm_model ?? null,
                dom_fingerprint: learningRes.dom_fingerprint,
                used_snapshot_key: learningRes.used_snapshot_key,
                snapshot_summaries: learningRes.snapshot_summaries,
                selector_plan: learningRes.selector_plan,
                schema_first: schemaFirstOut,
                blocked: true,
              });
              if (cancelled) return;

              const templateKeyFs = String(learningRes.dom_fingerprint || 'unknown').replace(/[^\w.-]+/g, '_');
              const templateRoot = path.join(artifactsBaseDir!, 'artifacts', 'kickstarter', runId, 'templates', templateKeyFs);
              await safeWriteJson(engine, path.join(templateRoot, 'selector-plan.json'), {
                site: 'kickstarter',
                page_type: pageType,
                url_pattern: urlPattern,
                schema_version: 'v1',
                prompt_version: 'page_understanding_v1',
                cache_status: learningRes.cache_status,
                learning_method: (learningRes as any).learning_method ?? null,
                llm_model: (learningRes as any).llm_model ?? null,
                dom_fingerprint: learningRes.dom_fingerprint,
                used_snapshot_key: learningRes.used_snapshot_key,
                schema_first: schemaFirstOut,
                selector_plan: selectorPlanForEval,
              });
              if (cancelled) return;

              await safeWriteJson(engine, artifactPaths.extractionResult, row);
              if (cancelled) return;
              await safeAppendTrace(
                engine,
                artifactPaths.engineTraceJsonl,
                engine.createEngineTraceEvent({
                  run_id: runId,
                  site: 'kickstarter',
                  url,
                  page_key: pageKey,
                  stage: 'completed',
                  event: 'completed',
                  status: 'failed',
                  cache_status: learningRes.cache_status,
                  input_summary: undefined,
                  output_summary: { duration_ms: Date.now() - startedAt.getTime() },
                  error: { type: 'blocked', message: 'blocked' },
                }),
              );
              if (cancelled) return;
            }

            return;
          }
          if (cancelled) return;
          const exec = (await page.evaluate(`
        (function () {
          function clean(v) { return String(v || '').replace(/\\s+/g, ' ').trim(); }
          function getByPath(root, path) {
            try {
              var parts = String(path || '').split('.').filter(Boolean);
              var cur = root;
              for (var i = 0; i < parts.length; i++) {
                var key = parts[i];
                if (cur == null) return null;
                cur = cur[key];
              }
              return cur;
            } catch (e) {
              return null;
            }
          }
          function parseContainsSelector(selector) {
            try {
              var s = String(selector || '');
              var idx = s.indexOf(':contains(');
              if (idx < 0) return null;
              var base = s.slice(0, idx).trim();
              var inside = s.slice(idx + ':contains('.length);
              if (inside[inside.length - 1] === ')') inside = inside.slice(0, -1);
              inside = inside.trim();
              var quote = inside[0];
              if (quote !== '"' && quote !== "'") return null;
              var last = inside.lastIndexOf(quote);
              if (last <= 0) return null;
              var needle = inside.slice(1, last);
              return { base: base || '*', needle: needle };
            } catch (e) {
              return null;
            }
          }
          function iterElementsForSelector(selector) {
            var parsed = parseContainsSelector(selector);
            var baseSel = parsed ? parsed.base : selector;
            var needle = parsed ? String(parsed.needle || '') : '';
            try {
              var nodes = document.querySelectorAll(baseSel);
              if (!parsed) return nodes;
              var filtered = [];
              for (var i = 0; i < nodes.length; i++) {
                var el = nodes[i];
                var t = clean(el && el.textContent ? el.textContent : '');
                if (t && t.indexOf(needle) >= 0) filtered.push(el);
              }
              return filtered;
            } catch (e) {
              return [];
            }
          }
          function valueFromElement(el) {
            if (!el) return null;
            var tag = (el.tagName || '').toLowerCase();
            if (tag === 'meta') {
              var c = el.getAttribute('content');
              return clean(c || '') || null;
            }
            if (tag === 'link') {
              var h = el.getAttribute('href');
              return clean(h || '') || null;
            }
            if (tag === 'a') {
                var ah = (el.getAttribute && el.getAttribute('href')) || (el.href || '');
                return clean(ah || '') || null;
            }
            if (tag === 'img') {
              var isrc = (el.currentSrc || '') || (el.getAttribute && el.getAttribute('src')) || '';
              return clean(isrc || '') || null;
            }
            if (tag === 'video') {
              var vsrc = (el.currentSrc || '') || (el.getAttribute && el.getAttribute('src')) || '';
              return clean(vsrc || '') || null;
            }
            if (tag === 'source') {
              var ssrc = (el.getAttribute && el.getAttribute('src')) || '';
              return clean(ssrc || '') || null;
            }
            if (tag === 'iframe') {
              var fsrc = (el.getAttribute && el.getAttribute('src')) || '';
              return clean(fsrc || '') || null;
            }
            if (tag === 'time') {
              var dt = el.getAttribute('datetime');
              if (dt) return clean(dt) || null;
            }
            var text = clean(el.textContent || '');
            return text || null;
          }
          function firstValue(selector) {
            try {
              if (typeof selector === 'string' && selector.indexOf('__win__:') === 0) {
                var p = selector.slice('__win__:'.length);
                var v = getByPath(window, p);
                if (v === null || v === undefined) return null;
                if (typeof v === 'object') return clean(JSON.stringify(v));
                return clean(String(v)) || null;
              }
              var els = iterElementsForSelector(selector);
              if (!els || els.length === 0) return null;
              for (var i = 0; i < els.length; i++) {
                var v2 = valueFromElement(els[i]);
                if (v2) return v2;
              }
              return null;
            } catch (e) {
              return null;
            }
          }

          var plan = ${JSON.stringify(selectorPlanForEval)};
          var values = {};
          var provenance = {};
          var plans = (plan && plan.plans && Array.isArray(plan.plans)) ? plan.plans : [];

          for (var i = 0; i < plans.length; i++) {
            var p = plans[i] || {};
            var field = String(p.field || '').trim();
            if (!field) continue;
            var selectors = Array.isArray(p.selectors) ? p.selectors : [];
            var fallback = Array.isArray(p.fallback_selectors) ? p.fallback_selectors : [];

            var got = null;
            var used = null;
            var strategy = null;

            for (var j = 0; j < selectors.length; j++) {
              var s = String(selectors[j] || '').trim();
              if (!s) continue;
              var t = firstValue(s);
              if (t) { got = t; used = s; strategy = 'selector'; break; }
            }
            if (!got) {
              for (var k = 0; k < fallback.length; k++) {
                var fs = String(fallback[k] || '').trim();
                if (!fs) continue;
                var ft = firstValue(fs);
                if (ft) { got = ft; used = fs; strategy = 'fallback_selector'; break; }
              }
            }
            if (got) {
              values[field] = got;
              provenance[field] = { strategy: strategy, selector: used };
            } else {
              values[field] = null;
              provenance[field] = { strategy: 'missing' };
            }
          }
          return { values: values, provenance: provenance };
        })()
      `)) as ExecPayload;

      const values =
        exec && typeof exec === 'object' && exec.values && typeof exec.values === 'object'
          ? exec.values
          : {};
      const provenance =
        exec && typeof exec === 'object' && exec.provenance && typeof exec.provenance === 'object'
          ? exec.provenance
          : {};
      if (cancelled) return;

      const core: Record<string, unknown> = {
        title: typeof values.title === 'string' ? values.title : (t.title ?? null),
        url,
        raw_id: typeof values.raw_id === 'string' ? values.raw_id : rawIdFallback,
      };

      const extra: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(values)) {
        if (field in core) continue;
        extra[field] = {
          value,
          value_type:
            typeof value === 'number' ? 'number' : typeof value === 'string' ? 'text' : 'unknown',
          provenance: (provenance as any)?.[field] ?? { strategy: 'missing' },
        };
      }

      const extractionWarning = buildExtractionWarning({
        snapshotSummaries: (learningRes as any)?.snapshot_summaries ?? null,
        values,
        selectorPlan: selectorPlanForEval,
        listTitle: t.title ?? null,
      });
      if (extractionWarning.flagged) {
        extra.warning = {
          value: true,
          value_type: 'boolean',
          provenance: { strategy: 'heuristic_warning' },
        };
        extra.warning_codes = {
          value: extractionWarning.codes.join(','),
          value_type: 'text',
          provenance: { strategy: 'heuristic_warning' },
        };
        extra.warning_message = {
          value: extractionWarning.message,
          value_type: 'text',
          provenance: { strategy: 'heuristic_warning' },
        };
      }

      const row = {
        site: 'kickstarter',
        page_type: pageType,
        ...core,
        extra,
      };
      if (cancelled) return;
      rows.push(row);

      if (cancelled) return;
      if (artifactPaths && runId) {
        const schemaFirstOut = {
          enabled: true,
          schema_registry_file_path: schemaRegistryFilePath,
          schema_hint_prompt: schema_hint_prompt ?? null,
          core_schema: (learningRes as any).core_schema ?? null,
          core_schema_sig: (learningRes as any).core_schema_sig ?? null,
          schema_variant_key: (learningRes as any).schema_variant_key ?? null,
          schema_cache_status: (learningRes as any).schema_cache_status ?? null,
          schema_learning_method: (learningRes as any).schema_learning_method ?? null,
          schema_llm_model: (learningRes as any).schema_llm_model ?? null,
          schema_used_snapshot_key: (learningRes as any).schema_used_snapshot_key ?? null,
          schema_snapshot_summaries: (learningRes as any).schema_snapshot_summaries ?? null,
        };
        await safeWriteJson(engine, path.join(artifactPaths.root, 'engine-output.json'), {
          cache_status: learningRes.cache_status,
          learning_method: (learningRes as any).learning_method ?? null,
          llm_model: (learningRes as any).llm_model ?? null,
          dom_fingerprint: learningRes.dom_fingerprint,
          used_snapshot_key: learningRes.used_snapshot_key,
          snapshot_summaries: learningRes.snapshot_summaries,
          selector_plan: learningRes.selector_plan,
          schema_first: schemaFirstOut,
          warning: extractionWarning.flagged
            ? { codes: extractionWarning.codes, message: extractionWarning.message }
            : null,
        });
        if (cancelled) return;
        // Template artifact: shared selector-plan for the same dom_fingerprint.
        // This matches the "learn once, reuse N times" mental model for list->detail crawl.
        const templateKeyFs = String(learningRes.dom_fingerprint || 'unknown').replace(/[^\w.-]+/g, '_');
        const templateRoot = path.join(artifactsBaseDir!, 'artifacts', 'kickstarter', runId, 'templates', templateKeyFs);
        await safeWriteJson(engine, path.join(templateRoot, 'selector-plan.json'), {
          site: 'kickstarter',
          page_type: pageType,
          url_pattern: urlPattern,
          schema_version: 'v1',
          prompt_version: 'page_understanding_v1',
          cache_status: learningRes.cache_status,
          learning_method: (learningRes as any).learning_method ?? null,
          llm_model: (learningRes as any).llm_model ?? null,
          dom_fingerprint: learningRes.dom_fingerprint,
          used_snapshot_key: learningRes.used_snapshot_key,
          schema_first: schemaFirstOut,
          selector_plan: selectorPlanForEval,
        });
        if (cancelled) return;
        await safeWriteJson(engine, artifactPaths.extractionResult, row);
        if (cancelled) return;
        await safeAppendTrace(
          engine,
          artifactPaths.engineTraceJsonl,
          engine.createEngineTraceEvent({
            run_id: runId,
            site: 'kickstarter',
            url,
            page_key: pageKey,
            stage: 'completed',
            event: 'completed',
            status: 'succeeded',
            cache_status: learningRes.cache_status,
            input_summary: undefined,
            output_summary: {
              duration_ms: Date.now() - startedAt.getTime(),
              warning_codes: extractionWarning.flagged ? extractionWarning.codes : [],
            },
            error: null,
          }),
        );
        if (cancelled) return;
      }
            })(),
            detailTimeoutMs,
            'kickstarter/crawl detail',
            () => {
              cancelled = true;
            },
          );

          finalError = null;
          break;
        } catch (e) {
          finalError = e;
          if (!isRecoverable(e) || attempt >= sched.maxRetries) break;
          await sleepMs(backoffMs(sched, attempt + 1, rng));
        }
      }

      if (rows.length === beforeRowsLen && finalError) {
        const msg = finalError instanceof Error ? finalError.message : String(finalError);
        rows.push({
          site: 'kickstarter',
          page_type: pageType,
          title: t.title ?? null,
          url,
          raw_id: rawIdFallback,
          extra: {
            error: { value: msg, value_type: 'text', provenance: { strategy: 'error' } },
          },
        });
      }

      doneCount += 1;
      await sleepMs(sched.afterEachMs + jitterMs(rng, sched.afterEachJitterMs));
      await cooldownGate.maybeCooldown(doneCount);
    }

    return rows;
  },
});

export const __test__ = {
  MAX_LIMIT,
  normalizeLimit,
  resolveSearchUrl,
  shouldAdvanceListPage,
  toAbsoluteUrl,
  rawIdFromKickstarterUrl,
  buildExtractionWarning,
};
