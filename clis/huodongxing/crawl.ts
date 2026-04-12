import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuthRequiredError, EmptyResultError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import type { IPage } from '@jackwener/opencli/types';

const DOMAIN = 'www.huodongxing.com';
const BASE_URL = 'https://www.huodongxing.com';
const DEFAULT_SEARCH_URL = BASE_URL + '/search?wd=AI';
const MAX_LIMIT = 50;

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

function normalizeLimit(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 20;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

function resolveSearchUrl(input: unknown): string {
  const raw = String(input ?? '').trim();
  if (!raw) return DEFAULT_SEARCH_URL;
  if (/^https?:\/\//i.test(raw)) return raw;
  return BASE_URL + '/search?wd=' + encodeURIComponent(raw);
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

function rawIdFromHuodongxingUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/event\/(\d+)/) ?? u.pathname.match(/\/event\/([^/?#]+)/);
    return m?.[1] ? String(m[1]) : null;
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

function getLearningModeFromEnv(): 'auto' | 'llm_only' | 'heuristic_only' | undefined {
  const raw = process.env.OPENCLI_HUODONGXING_LEARNING_MODE?.trim();
  if (!raw) return undefined;
  if (raw === 'auto' || raw === 'llm_only' || raw === 'heuristic_only') return raw;
  return undefined;
}

function getHuodongxingSchemaRegistryPath(): string {
  const overridden = process.env.OPENCLI_HUODONGXING_SCHEMA_REGISTRY_PATH?.trim();
  if (overridden) return overridden;
  return path.join(os.homedir(), '.opencli', 'huodongxing-core-schema.json');
}

function getSchemaHintPromptFromEnv(): string | undefined {
  const raw = process.env.OPENCLI_HUODONGXING_SCHEMA_HINT_PROMPT?.trim();
  return raw ? raw : undefined;
}

function getRuleCacheFilePath(): string {
  const overridden = process.env.OPENCLI_HUODONGXING_RULE_CACHE_PATH?.trim();
  if (overridden) return overridden;
  return path.join(os.homedir(), '.opencli', 'huodongxing-rule-cache.json');
}

function makeRunId(): string {
  return 'hx_' + nowIsoUtc8().replace(/[:.]/g, '-');
}

type ExecPayload = {
  values: Record<string, unknown>;
  provenance?: Record<string, unknown>;
};

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
  site: 'huodongxing',
  name: 'crawl',
  description: 'Huodongxing list -> event detail crawl (schema-first, cache-first)',
  domain: DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: 'query_or_url',
      positional: true,
      required: false,
      help: 'Search keyword or full Huodongxing search URL',
    },
    { name: 'limit', type: 'int', default: 10, help: 'Number of events to crawl (max 50)' },
  ],
  columns: ['title', 'url', 'raw_id'],
  func: async (page: IPage, kwargs) => {
    const engine = await import('mkt-learning-engine');
    const artifactsBaseDir = getArtifactsBaseDir();
    const runId = artifactsBaseDir ? makeRunId() : null;

    const limit = normalizeLimit(kwargs.limit);
    const listUrl = resolveSearchUrl(kwargs.query_or_url);

    await page.goto(listUrl);
    try {
      await page.wait(1);
    } catch {
      // Best effort only
    }

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

        var body = document.body;
        var bodyText = clean(body && body.innerText ? body.innerText : '');
        var authRequired = /log in|sign in|please sign in|please log in|captcha|verify|verification|risk|风控|登录|验证/i.test(bodyText);

        var anchors = document.querySelectorAll('a[href*=\"/event/\"]');
        var dedupe = Object.create(null);
        var items = [];

        for (var i = 0; i < anchors.length; i++) {
          var a = anchors[i];
          var href = (a.getAttribute && a.getAttribute('href')) || '';
          var url = a.href || href || '';
          var key = url || href;
          if (!key || dedupe[key]) continue;
          dedupe[key] = true;
          var card = (a.closest && a.closest('article, li, div')) || a;
          var title = clean(
            (a.getAttribute && a.getAttribute('title'))
              || firstText(a, ['h1', 'h2', 'h3', 'h4'])
              || a.textContent
          );
          items.push({ title: title || null, url: url || null });
          if (items.length >= ${limit}) break;
        }
        return { authRequired: authRequired, items: items };
      })()
    `)) as { authRequired?: boolean; items?: Array<Record<string, unknown>> };

    const rawItems = Array.isArray(listPayload?.items) ? listPayload.items : [];
    const targets = rawItems
      .map((item) => ({
        title: typeof item.title === 'string' ? item.title : null,
        url: toAbsoluteUrl(item.url),
      }))
      .filter((x) => Boolean(x.url));

    if (listPayload?.authRequired && targets.length === 0) {
      throw new AuthRequiredError(DOMAIN, 'AuthRequired: huodongxing/crawl requires login or passed verification');
    }
    if (targets.length === 0) {
      throw new EmptyResultError('huodongxing/crawl', 'No event URLs found on list page');
    }

    const cacheFilePath = getRuleCacheFilePath();
    const llm = getLlmConfigFromEnv();
    const learning_mode = getLearningModeFromEnv();
    const schemaRegistryFilePath = getHuodongxingSchemaRegistryPath();
    const schema_hint_prompt = getSchemaHintPromptFromEnv();

    const pageType = 'event_detail';
    const urlPattern = '/event/:id';

    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      const url = t.url!;

      await page.goto(url);
      const s0html = await page.evaluate('document.documentElement.outerHTML');
      try {
        await page.wait(1);
      } catch {}
      const s1html = await page.evaluate('document.documentElement.outerHTML');
      try {
        await page.autoScroll();
      } catch {}
      try {
        await page.wait(1);
      } catch {}
      const s2html = await page.evaluate('document.documentElement.outerHTML');

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

      const rawId = rawIdFromHuodongxingUrl(url);
      const pageKey = `${pageType}:${urlPattern}#${rawId ?? String(i + 1)}`;
      const artifactPaths =
        artifactsBaseDir && runId
          ? engine.buildLearningArtifactPaths({
              baseDir: artifactsBaseDir,
              site: 'huodongxing',
              runId,
              pageKey,
            })
          : null;

      if (artifactPaths) {
        const snapshotsDir = path.join(artifactPaths.root, 'snapshots');
        await safeWriteText(path.join(snapshotsDir, 's0.html'), html_snapshots.s0.html);
        await safeWriteText(path.join(snapshotsDir, 's1.html'), html_snapshots.s1.html);
        await safeWriteText(path.join(snapshotsDir, 's2.html'), html_snapshots.s2.html);
        await safeWriteJson(engine, artifactPaths.rawPage, {
          site: 'huodongxing',
          page_type: pageType,
          url,
          url_pattern: urlPattern,
          html_snapshots_summary: htmlSnapshotsSummary,
        });
        await safeWriteJson(engine, path.join(artifactPaths.root, 'engine-input.json'), {
          site: 'huodongxing',
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
          snapshots_saved: true,
        });
      }

      const startedAt = new Date();
      const learningRes = await engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1({
        schemaRegistryFilePath,
        selectorCacheFilePath: cacheFilePath,
        site: 'huodongxing',
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

      const selectorPlanForEval = learningRes.selector_plan ?? { plans: [] };
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
            if (tag === 'time') {
              var dt = el.getAttribute('datetime');
              if (dt) return clean(dt) || null;
            }
            if (tag === 'a') {
              var href = el.getAttribute('href');
              if (href) return clean(href) || null;
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

      const core: Record<string, unknown> = {
        title: typeof values.title === 'string' ? values.title : (t.title ?? null),
        url,
        raw_id: typeof values.raw_id === 'string' ? values.raw_id : rawId,
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

      const row = {
        site: 'huodongxing',
        page_type: pageType,
        ...core,
        extra,
      };
      rows.push(row);

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
        });
        await safeWriteJson(engine, artifactPaths.selectorPlan, {
          site: 'huodongxing',
          page_type: pageType,
          url,
          url_pattern: urlPattern,
          schema_version: 'v1',
          prompt_version: 'page_understanding_v1',
          cache_status: learningRes.cache_status,
          learning_method: (learningRes as any).learning_method ?? null,
          llm_model: (learningRes as any).llm_model ?? null,
          dom_fingerprint: learningRes.dom_fingerprint,
          used_snapshot_key: learningRes.used_snapshot_key,
          snapshot_summaries: learningRes.snapshot_summaries,
          schema_first: schemaFirstOut,
          selector_plan: selectorPlanForEval,
        });
        await safeWriteJson(engine, artifactPaths.extractionResult, row);
        await safeAppendTrace(
          engine,
          artifactPaths.engineTraceJsonl,
          engine.createEngineTraceEvent({
            run_id: runId,
            site: 'huodongxing',
            url,
            page_key: pageKey,
            stage: 'completed',
            event: 'completed',
            status: 'succeeded',
            cache_status: learningRes.cache_status,
            input_summary: undefined,
            output_summary: { duration_ms: Date.now() - startedAt.getTime() },
            error: null,
          }),
        );
      }
    }

    return rows;
  },
});

export const __test__ = {
  MAX_LIMIT,
  normalizeLimit,
  resolveSearchUrl,
  toAbsoluteUrl,
  rawIdFromHuodongxingUrl,
};

