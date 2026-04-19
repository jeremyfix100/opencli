import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import type { IPage } from '@jackwener/opencli/types';
import { normalizeExtractedMediaFields } from '../_shared/media.js';

const DOMAIN = 'www.huodongxing.com';
const BASE_URL = 'https://www.huodongxing.com';

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

function toAbsoluteUrl(value: string): string {
  const raw = String(value ?? '').trim();
  const u = new URL(raw, BASE_URL);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Invalid URL protocol: ${u.protocol}`);
  }
  return u.toString();
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

function getLearningModeFromEnv(): 'auto' | 'llm_only' | 'heuristic_only' | 'cache_only' | undefined {
  const raw = process.env.OPENCLI_HUODONGXING_LEARNING_MODE?.trim();
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
  name: 'project',
  description: 'Huodongxing event detail (schema-first; engine learns, opencli executes)',
  domain: DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: 'url', positional: true, required: true, help: 'Huodongxing event detail URL' }],
  columns: ['title', 'url', 'raw_id'],
  func: async (page: IPage, kwargs) => {
    const engine = await import('mkt-learning-engine');
    const artifactsBaseDir = getArtifactsBaseDir();
    const runId = artifactsBaseDir ? makeRunId() : null;

    const url = toAbsoluteUrl(String(kwargs.url ?? ''));
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
    const pageType = 'event_detail';
    const urlPattern = `${new URL(url).origin}/event/:id`;
    const pageKey = rawId ? `event_detail___event___id_${rawId}` : `${pageType}:${urlPattern}`;

    const artifactPaths =
      artifactsBaseDir && runId
        ? engine.buildLearningArtifactPaths({
            baseDir: artifactsBaseDir,
            site: 'huodongxing',
            runId,
            pageKey,
          })
        : null;

    const learning_mode = getLearningModeFromEnv();
    const saveHtmlSnapshots = shouldSaveHtmlSnapshots(learning_mode);

    if (artifactPaths && saveHtmlSnapshots) {
      const snapshotsDir = path.join(artifactPaths.root, 'snapshots');
      await safeWriteText(path.join(snapshotsDir, 's0.html'), html_snapshots.s0.html);
      await safeWriteText(path.join(snapshotsDir, 's1.html'), html_snapshots.s1.html);
      await safeWriteText(path.join(snapshotsDir, 's2.html'), html_snapshots.s2.html);
    }
    if (artifactPaths) {
      await safeWriteJson(engine, artifactPaths.rawPage, {
        site: 'huodongxing',
        page_type: pageType,
        url,
        html_snapshots_summary: htmlSnapshotsSummary,
      });
    }

    const startedAt = new Date();
    const cacheFilePath = getRuleCacheFilePath();
    const llm = getLlmConfigFromEnv();
    // learning_mode already resolved above for snapshot persistence strategy.

    const schemaRegistryFilePath = getHuodongxingSchemaRegistryPath();
    const schema_hint_prompt = getSchemaHintPromptFromEnv();

    let learningRes: Awaited<ReturnType<(typeof engine)['getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1']>>;
    try {
      learningRes = await engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1({
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
    } catch (e) {
      const code = typeof (e as any)?.code === 'string' ? String((e as any).code) : undefined;
      if (code === 'schema_cache_miss_requires_learn' || code === 'selector_cache_miss_requires_learn') {
        throw new Error('需要先 Learn：缓存缺失（core_schema / selector_plan）。请先执行 Learn，再 Run + Persist。');
      }
      throw e;
    }

    const selectorPlanForEval = (learningRes as any).selector_plan ?? { plans: [] };
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
          if (tag === 'img') {
            var src = el.getAttribute('src');
            if (src) return clean(src) || null;
          }
          var text = clean(el.textContent || '');
          return text || null;
        }
        function firstValue(selector) {
          try {
            if (!selector) return null;
            var s = String(selector || '').trim();
            if (!s) return null;
            if (s.indexOf('__win__:') === 0) {
              var p = s.slice('__win__:'.length);
              var v = getByPath(window, p);
              if (v === null || v === undefined) return null;
              if (typeof v === 'object') return clean(JSON.stringify(v));
              return clean(String(v)) || null;
            }
            var els = iterElementsForSelector(s);
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
        var plans = Array.isArray(plan && plan.plans) ? plan.plans : [];
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
            var sel = String(selectors[j] || '').trim();
            if (!sel) continue;
            var hit = firstValue(sel);
            if (hit) { got = hit; used = sel; strategy = 'selector'; break; }
          }
          if (!got) {
            for (var k = 0; k < fallback.length; k++) {
              var fsel = String(fallback[k] || '').trim();
              if (!fsel) continue;
              var fhit = firstValue(fsel);
              if (fhit) { got = fhit; used = fsel; strategy = 'fallback_selector'; break; }
            }
          }

          if (got) {
            values[field] = got;
            provenance[field] = { strategy: strategy, selector: used, confidence: p.confidence || null };
          } else {
            values[field] = null;
            provenance[field] = { strategy: 'missing', selector: null, confidence: p.confidence || null };
          }
        }
        return { values: values, provenance: provenance };
      })();
    `)) as { values: Record<string, unknown>; provenance?: Record<string, unknown> };

    const values = exec?.values ?? {};
    const provenance = exec?.provenance ?? {};
    values.url = url;
    if (rawId) values.raw_id = rawId;

    const signals = engine.buildSchemaDiscoverySignalsV1({ html: html_snapshots.s2.html });
    const titleFromMeta = typeof (signals as any)?.meta?.og_title === 'string' ? (signals as any).meta.og_title : null;

    const core: Record<string, unknown> = {
      title: (values as any).title ?? titleFromMeta ?? null,
      url,
      raw_id: rawId ?? (values as any).raw_id ?? null,
    };

    const extra: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(values)) {
      if (field in core) continue;
      extra[field] = {
        value,
        value_type: typeof value === 'number' ? 'number' : typeof value === 'string' ? 'text' : 'unknown',
        provenance: (provenance as any)?.[field] ?? { strategy: 'missing' },
      };
    }

    const row = {
      site: 'huodongxing',
      page_type: pageType,
      ...core,
      ...normalizeExtractedMediaFields(values, url),
      extra,
    };

    if (artifactPaths && runId) {
      const planFields = Array.isArray(selectorPlanForEval?.plans)
        ? selectorPlanForEval.plans.map((p: any) => String(p?.field ?? '')).filter(Boolean)
        : [];
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
      await safeWriteJson(engine, artifactPaths.selectorPlan, {
        site: 'huodongxing',
        page_type: pageType,
        url,
        url_pattern: urlPattern,
        schema_version: 'v1',
        prompt_version: 'page_understanding_v1',
        cache_status: (learningRes as any).cache_status ?? null,
        learning_method: (learningRes as any).learning_method ?? null,
        llm_model: (learningRes as any).llm_model ?? null,
        dom_fingerprint: (learningRes as any).dom_fingerprint ?? null,
        used_snapshot_key: (learningRes as any).used_snapshot_key ?? null,
        snapshot_summaries: (learningRes as any).snapshot_summaries ?? null,
        plans_count: planFields.length,
        plan_fields: planFields,
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
          cache_status: (learningRes as any).cache_status ?? 'na',
          input_summary: undefined,
          output_summary: { duration_ms: Date.now() - startedAt.getTime() },
          error: null,
        }),
      );
    }

    return row;
  },
});
