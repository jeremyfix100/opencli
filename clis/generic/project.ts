import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { cli, Strategy } from '@jackwener/opencli/registry';
import type { IPage } from '@jackwener/opencli/types';
import { normalizeExtractedMediaFields } from '../_shared/media.js';

function nowIsoUtc8(): string {
  const d = new Date();
  const shifted = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const Y = shifted.getUTCFullYear();
  const M = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const D = String(shifted.getUTCDate()).padStart(2, '0');
  const h = String(shifted.getUTCHours()).padStart(2, '0');
  const m = String(shifted.getUTCMinutes()).padStart(2, '0');
  const s = String(shifted.getUTCSeconds()).padStart(2, '0');
  const ms = String(shifted.getUTCMilliseconds()).padStart(3, '0');
  return `${Y}-${M}-${D}T${h}:${m}:${s}.${ms}+08:00`;
}

function sanitizeToken(value: string, fallback = 'unknown'): string {
  const cleaned = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const trimmed = cleaned.replace(/^_+|_+$/g, '');
  return trimmed.length > 0 ? trimmed : fallback;
}

function safeSlice(value: string, maxLen: number): string {
  const s = String(value ?? '');
  if (s.length <= maxLen) return s;
  return s.slice(0, Math.max(0, maxLen));
}

function sha1Hex(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function getArtifactsBaseDir(): string | null {
  const dir = process.env.OPENCLI_LEARNING_ARTIFACTS_DIR?.trim();
  return dir ? dir : null;
}

function getLearningModeFromEnv(): 'auto' | 'llm_only' | 'heuristic_only' | 'cache_only' | undefined {
  const raw = process.env.OPENCLI_GENERIC_LEARNING_MODE?.trim();
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

function getVirtualSiteFromEnv(url: URL): string {
  const overridden = process.env.OPENCLI_VIRTUAL_SITE?.trim();
  if (overridden) return overridden;
  return url.hostname;
}

function getPageTypeFromEnv(): string {
  const overridden = process.env.OPENCLI_GENERIC_PAGE_TYPE?.trim();
  return overridden && overridden.length > 0 ? overridden : 'page';
}

function getGenericSchemaRegistryPath(): string {
  const overridden = process.env.OPENCLI_GENERIC_SCHEMA_REGISTRY_PATH?.trim();
  if (overridden) return overridden;
  return path.join(os.homedir(), '.opencli', 'generic-core-schema.json');
}

function getRuleCacheFilePath(): string {
  const overridden = process.env.OPENCLI_GENERIC_RULE_CACHE_PATH?.trim();
  if (overridden) return overridden;
  return path.join(os.homedir(), '.opencli', 'generic-rule-cache.json');
}

function readWaitSecondsFromEnv(key: string, fallbackSeconds: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallbackSeconds;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallbackSeconds;
  return n;
}

async function safeWriteText(filePath: string, content: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
  } catch {
    // best-effort only
  }
}

async function safeWriteJson(engine: typeof import('mkt-learning-engine'), filePath: string, payload: unknown): Promise<void> {
  try {
    await engine.writeArtifactJson(filePath, payload);
  } catch {
    // best-effort only
  }
}

cli({
  site: 'generic',
  name: 'project',
  description: 'Generic page project (snapshot capture; optional cache-only extraction via OPENCLI_GENERIC_LEARNING_MODE).',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [{ name: 'url', positional: true, required: true, help: 'Any http(s) URL' }],
  columns: ['url', 'site', 'page_type'],
  func: async (page: IPage, kwargs) => {
    const raw = String(kwargs.url ?? '').trim();
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Invalid URL protocol: ${url.protocol}`);
    }

    const virtualSite = getVirtualSiteFromEnv(url);
    const pageType = getPageTypeFromEnv();
    const waitAfterGotoSeconds = readWaitSecondsFromEnv('OPENCLI_GENERIC_WAIT_AFTER_GOTO_SECONDS', 2);
    const waitAfterScrollSeconds = readWaitSecondsFromEnv('OPENCLI_GENERIC_WAIT_AFTER_SCROLL_SECONDS', 2);

    const learning_mode = getLearningModeFromEnv();
    const artifactsBaseDir = getArtifactsBaseDir();
    const opencliRunId = artifactsBaseDir ? `generic_${nowIsoUtc8().replace(/[:.]/g, '-')}` : null;

    await page.goto(url.toString());

    const s0html = await page.evaluate('document.documentElement.outerHTML');
    try {
      await page.wait(waitAfterGotoSeconds);
    } catch {}
    const s1html = await page.evaluate('document.documentElement.outerHTML');
    try {
      await page.autoScroll();
    } catch {}
    try {
      await page.wait(waitAfterScrollSeconds);
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

    const urlPattern = `${url.origin}${url.pathname}`;
    const pageKeyHash = sha1Hex(`${virtualSite}|${pageType}|${urlPattern}`).slice(0, 10);
    const hostToken = sanitizeToken(virtualSite, 'host');
    const pathToken = sanitizeToken(url.pathname.replace(/\//g, '_'), 'root');
    const pageKey = safeSlice(`${sanitizeToken(pageType, 'page')}___${hostToken}___${pathToken}___${pageKeyHash}`, 160);

    const engine = await import('mkt-learning-engine');
    const artifactPaths =
      artifactsBaseDir && opencliRunId
        ? engine.buildLearningArtifactPaths({
            baseDir: artifactsBaseDir,
            site: virtualSite,
            runId: opencliRunId,
            pageKey,
          })
        : null;

    const saveHtmlSnapshots = shouldSaveHtmlSnapshots(learning_mode);
    if (artifactPaths && saveHtmlSnapshots) {
      const snapshotsDir = path.join(artifactPaths.root, 'snapshots');
      await safeWriteText(path.join(snapshotsDir, 's0.html'), html_snapshots.s0.html);
      await safeWriteText(path.join(snapshotsDir, 's1.html'), html_snapshots.s1.html);
      await safeWriteText(path.join(snapshotsDir, 's2.html'), html_snapshots.s2.html);
    }
    if (artifactPaths) {
      await safeWriteJson(engine, artifactPaths.rawPage, {
        site: virtualSite,
        page_type: pageType,
        url: url.toString(),
        url_pattern: urlPattern,
        html_snapshots_summary: htmlSnapshotsSummary,
        snapshots_saved: saveHtmlSnapshots,
      });
    }

    // Snapshot-only mode (default): used by /learning "learn-from-url" to capture s0~s2.
    if (!learning_mode) {
      return { url: url.toString(), site: virtualSite, page_type: pageType };
    }

    // Cache-only (or auto) extraction mode: used by Pipeline "Run + Persist".
    type EngineMod = typeof import('mkt-learning-engine');
    type LearningRes = Awaited<ReturnType<EngineMod['getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1']>>;
    let learningRes: LearningRes;
    try {
      const schemaRegistryFilePath = getGenericSchemaRegistryPath();
      const cacheFilePath = getRuleCacheFilePath();
      learningRes = await engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1({
        schemaRegistryFilePath,
        selectorCacheFilePath: cacheFilePath,
        site: virtualSite,
        page_type: pageType,
        url: url.toString(),
        url_pattern: urlPattern,
        schema_version: 'v1',
        prompt_version: 'page_understanding_v1',
        html_snapshots,
        learning_mode,
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
    type ExecPayload = { values: Record<string, unknown>; provenance?: Record<string, unknown> };
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
              if (t.indexOf(needle) >= 0) filtered.push(el);
            }
            return filtered;
          } catch (e) {
            return [];
          }
        }
        function firstValue(selector) {
          try {
            if (!selector) return null;
            if (String(selector).startsWith('meta:')) {
              var key = String(selector).slice('meta:'.length);
              var meta = document.querySelector('meta[property="' + key + '"], meta[name="' + key + '"]');
              if (!meta) return null;
              var v = meta.getAttribute('content');
              return clean(v || '') || null;
            }
            if (String(selector).startsWith('jsonld:')) {
              var path = String(selector).slice('jsonld:'.length);
              var nodes = document.querySelectorAll('script[type="application/ld+json"]');
              for (var i = 0; i < nodes.length; i++) {
                var raw = nodes[i].textContent || '';
                if (!raw) continue;
                try {
                  var json = JSON.parse(raw);
                  var got = getByPath(json, path);
                  if (got != null) {
                    if (typeof got === 'string') return clean(got) || null;
                    if (typeof got === 'number') return got;
                  }
                } catch (e) {}
              }
              return null;
            }
            if (String(selector).startsWith('title')) {
              var t = clean(document.title || '');
              return t || null;
            }
            var nodes = iterElementsForSelector(selector);
            for (var j = 0; j < nodes.length; j++) {
              var el = nodes[j];
              if (!el) continue;
              var tag = el.tagName ? el.tagName.toLowerCase() : '';
              if (tag === 'a') {
                var href = el.getAttribute('href');
                if (href) return clean(href) || null;
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

    const values = exec && typeof exec === 'object' && exec.values && typeof exec.values === 'object' ? exec.values : {};
    const provenance =
      exec && typeof exec === 'object' && exec.provenance && typeof exec.provenance === 'object' ? exec.provenance : {};

    const core: Record<string, unknown> = {
      title: typeof (values as any).title === 'string' ? (values as any).title : null,
      url: url.toString(),
      raw_id: typeof (values as any).raw_id === 'string' ? (values as any).raw_id : null,
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
      site: virtualSite,
      page_type: pageType,
      ...core,
      ...normalizeExtractedMediaFields(values as any, url.toString()),
      extra,
    };

    if (artifactPaths && opencliRunId) {
      const planFields = Array.isArray(selectorPlanForEval?.plans)
        ? selectorPlanForEval.plans.map((p: any) => String(p?.field ?? '')).filter(Boolean)
        : [];
      await safeWriteJson(engine, artifactPaths.selectorPlan, {
        site: virtualSite,
        page_type: pageType,
        url: url.toString(),
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
        selector_plan: selectorPlanForEval,
      });
      await safeWriteJson(engine, artifactPaths.extractionResult, row);
    }

    return row;
  },
});
