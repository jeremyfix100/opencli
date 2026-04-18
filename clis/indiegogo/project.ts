import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import type { IPage } from '@jackwener/opencli/types';
import { normalizeExtractedMediaFields } from '../_shared/media.js';

const DOMAIN = 'www.indiegogo.com';
const BASE_URL = 'https://www.indiegogo.com';

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

  // Prefer plugin-scoped override because opencli loads `.env` with override=true.
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
  const raw = process.env.OPENCLI_INDIEGOGO_LEARNING_MODE?.trim();
  if (!raw) return undefined;
  if (raw === 'auto' || raw === 'llm_only' || raw === 'heuristic_only' || raw === 'cache_only') return raw;
  return undefined;
}

function getIndiegogoSchemaRegistryPath(): string {
  const overridden = process.env.OPENCLI_INDIEGOGO_SCHEMA_REGISTRY_PATH?.trim();
  if (overridden) return overridden;
  return path.join(os.homedir(), '.opencli', 'indiegogo-core-schema.json');
}

function getSchemaHintPromptFromEnv(): string | undefined {
  const raw = process.env.OPENCLI_INDIEGOGO_SCHEMA_HINT_PROMPT?.trim();
  return raw ? raw : undefined;
}

function makeRunId(): string {
  // Use UTC+8 by default for human-friendly artifact directories.
  return 'ig_' + nowIsoUtc8().replace(/[:.]/g, '-');
}

function getRuleCacheFilePath(): string {
  const overridden = process.env.OPENCLI_INDIEGOGO_RULE_CACHE_PATH?.trim();
  if (overridden) return overridden;
  return path.join(os.homedir(), '.opencli', 'indiegogo-rule-cache.json');
}

function rawIdFromIndiegogoUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const idx = parts.indexOf('projects');
    if (idx < 0) return null;
    const rest = parts.slice(idx + 1);
    if (rest.length === 0) return null;
    return rest.join('/');
  } catch {
    return null;
  }
}

function normalizeIndiegogoRawId(value: unknown, url: string): string | null {
  const fallback = rawIdFromIndiegogoUrl(url);
  if (typeof value !== 'string') return fallback;
  const s = value.trim();
  if (!s) return fallback;
  if (/^\d{3,}$/.test(s)) return s;

  const m =
    s.match(/\bprojectId\b"\s*:\s*(\d+)/i) ??
    s.match(/\bprojectId\b\s*:\s*(\d+)/i) ??
    s.match(/\bprojectID\b"\s*:\s*(\d+)/i) ??
    s.match(/\bprojectID\b\s*:\s*(\d+)/i);
  if (m?.[1]) return m[1];

  // If it looks like a whole JS snippet, prefer stable URL-derived id.
  if (s.length > 120) return fallback;
  return s;
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

async function safeWriteText(filePath: string, content: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
  } catch {
    // Must never break crawl path
  }
}

cli({
  site: 'indiegogo',
  name: 'project',
  description: 'Indiegogo project detail (C1: engine learns, opencli executes)',
  domain: DOMAIN,
  strategy: Strategy.PUBLIC,
  browser: true,
  args: [{ name: 'url', positional: true, required: true, help: 'Indiegogo campaign URL' }],
  columns: ['title', 'url', 'raw_id'],
  func: async (page: IPage, kwargs) => {
    const engine = await import('mkt-learning-engine');
    const artifactsBaseDir = getArtifactsBaseDir();
    const runId = artifactsBaseDir ? makeRunId() : null;

    const url = toAbsoluteUrl(String(kwargs.url ?? ''));
    await page.goto(url);

    // S0: immediately after navigation
    const s0html = await page.evaluate('document.documentElement.outerHTML');

    try {
      await page.wait(1);
    } catch {
      // Best effort only
    }

    const pageType = 'project_detail';
    const urlPattern = '/:lang/projects/:slug';
    const pageKey = `${pageType}:${urlPattern}`;

    // S1: after a generic wait
    const s1html = await page.evaluate('document.documentElement.outerHTML');

    // S2: after a generic scroll + optional short wait
    try {
      await page.autoScroll();
    } catch {
      // Best effort only
    }
    try {
      await page.wait(1);
    } catch {
      // Best effort only
    }
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

    const artifactPaths =
      artifactsBaseDir && runId
        ? engine.buildLearningArtifactPaths({
            baseDir: artifactsBaseDir,
            site: 'indiegogo',
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
        site: 'indiegogo',
        page_type: pageType,
        url,
        html_snapshots_summary: htmlSnapshotsSummary,
      });
    }

    const cacheFilePath = getRuleCacheFilePath();
    const llm = getLlmConfigFromEnv();
    const learning_mode = getLearningModeFromEnv();
    const schemaRegistryFilePath = getIndiegogoSchemaRegistryPath();
    const schema_hint_prompt = getSchemaHintPromptFromEnv();

    if (artifactPaths && runId) {
      await safeWriteJson(engine, path.join(artifactPaths.root, 'engine-input.json'), {
        site: 'indiegogo',
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

    let learningRes: Awaited<ReturnType<(typeof engine)['getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1']>>;
    try {
      learningRes = await engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1({
        schemaRegistryFilePath,
        selectorCacheFilePath: cacheFilePath,
        site: 'indiegogo',
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
        learning_method: (learningRes as any).learning_method,
        llm_model: (learningRes as any).llm_model,
        dom_fingerprint: learningRes.dom_fingerprint,
        used_snapshot_key: learningRes.used_snapshot_key,
        snapshot_summaries: learningRes.snapshot_summaries,
        selector_plan: learningRes.selector_plan,
        schema_first: schemaFirstOut,
      });
    }

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
            // inside ends with ')'
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
          // Some LLM-generated selectors may target script tags; treat as text.
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
      title: typeof values.title === 'string' ? values.title : null,
      url,
      raw_id: normalizeIndiegogoRawId(values.raw_id, url),
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
      site: 'indiegogo',
      page_type: pageType,
      ...core,
      ...normalizeExtractedMediaFields(values, url),
      extra,
    };

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
      await safeWriteJson(engine, artifactPaths.selectorPlan, {
        cache_status: learningRes.cache_status,
        learning_method: (learningRes as any).learning_method,
        llm_model: (learningRes as any).llm_model,
        dom_fingerprint: learningRes.dom_fingerprint,
        used_snapshot_key: learningRes.used_snapshot_key,
        snapshot_summaries: learningRes.snapshot_summaries,
        schema_first: schemaFirstOut,
        selector_plan: selectorPlanForEval,
      });
      await safeWriteJson(engine, artifactPaths.extractionResult, row);
    }

    return row;
  },
});
