import os from 'node:os';
import path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import type { IPage } from '@jackwener/opencli/types';

const DOMAIN = 'www.kickstarter.com';
const BASE_URL = 'https://www.kickstarter.com';

function toAbsoluteUrl(value: string): string {
  const raw = String(value ?? '').trim();
  const u = new URL(raw, BASE_URL);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Invalid URL protocol: ${u.protocol}`);
  }
  return u.toString();
}

function canUseLlm(): boolean {
  return Boolean(
    process.env.MKT_CRAWLER_LLM_ENDPOINT &&
      process.env.MKT_CRAWLER_LLM_API_KEY &&
      process.env.MKT_CRAWLER_LLM_MODEL,
  );
}

function getArtifactsBaseDir(): string | null {
  const dir = process.env.OPENCLI_LEARNING_ARTIFACTS_DIR?.trim();
  return dir ? dir : null;
}

function makeRunId(): string {
  return 'ks_' + new Date().toISOString().replace(/[:.]/g, '-');
}

function getRuleCacheFilePath(): string {
  const overridden = process.env.OPENCLI_KICKSTARTER_RULE_CACHE_PATH?.trim();
  if (overridden) return overridden;
  return path.join(os.homedir(), '.opencli', 'kickstarter-rule-cache.json');
}

type Candidate = {
  node_id: string;
  selector: string;
  tag: string;
  text: string;
  href: string | null;
  datetime: string | null;
  title: string | null;
  aria_label: string | null;
  class_list: string[];
  attributes: Record<string, string>;
  text_length: number;
  depth: number;
  sibling_index: number;
};

type SnapshotPayload = {
  page_title: string;
  candidates: Candidate[];
  selectorSignature: string[];
  authRequired?: boolean;
};

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

cli({
  site: 'kickstarter',
  name: 'project',
  description: 'Kickstarter project detail (C1: engine learns, opencli executes)',
  domain: DOMAIN,
  strategy: Strategy.PUBLIC,
  browser: true,
  args: [{ name: 'url', positional: true, required: true, help: 'Kickstarter project URL' }],
  columns: ['title', 'creator_name', 'backers', 'pledged_amount', 'goal_amount', 'percent_funded', 'currency', 'deadline', 'url', 'raw_id'],
  func: async (page: IPage, kwargs) => {
    const engine = await import('mkt-learning-engine');
    const artifactsBaseDir = getArtifactsBaseDir();
    const runId = artifactsBaseDir ? makeRunId() : null;

    const url = toAbsoluteUrl(String(kwargs.url ?? ''));
    await page.goto(url);
    try {
      await page.wait(1);
    } catch {
      // Best effort only
    }

    const snapshot = (await page.evaluate(`
      (function () {
        function clean(v) { return String(v || '').replace(/\\s+/g, ' ').trim(); }
        function cssPath(el) {
          if (!el || !el.nodeType || el.nodeType !== 1) return '';
          var parts = [];
          var cur = el;
          for (var depth = 0; cur && depth < 5; depth++) {
            var tag = (cur.tagName || '').toLowerCase();
            if (!tag) break;
            var id = cur.id ? ('#' + cur.id.replace(/[^a-zA-Z0-9_-]/g, '')) : '';
            var cls = '';
            if (cur.classList && cur.classList.length) {
              cls = '.' + Array.prototype.slice.call(cur.classList, 0, 2)
                .map(function (x) { return String(x).replace(/[^a-zA-Z0-9_-]/g, ''); })
                .filter(Boolean)
                .join('.');
            }
            parts.unshift(tag + id + cls);
            cur = cur.parentElement;
          }
          return parts.join(' > ');
        }
        var body = document.body;
        var title = clean(document.title || '');
        var bodyText = clean(body && body.innerText ? body.innerText : '');
        var authRequired = /log in|sign in|please sign in|please log in|captcha|verify|verification|risk|风控|登录|验证/i.test(bodyText);

        var selector = 'h1,h2,h3,h4,p,li,div,span,time,a,strong,b';
        var nodes = document.querySelectorAll(selector);
        var out = [];
        var sig = Object.create(null);
        for (var i = 0; i < nodes.length && out.length < 250; i++) {
          var el = nodes[i];
          if (!el || !el.textContent) continue;
          var text = clean(el.textContent);
          if (!text || text.length < 2 || text.length > 120) continue;
          var rects = el.getClientRects ? el.getClientRects() : null;
          if (rects && rects.length === 0) continue;
          var sel = cssPath(el);
          if (!sel) continue;
          sig[sel] = true;
          var clsList = [];
          try { clsList = el.classList ? Array.prototype.slice.call(el.classList, 0, 6) : []; } catch {}
          var attrs = {};
          try {
            if (el.getAttribute) {
              var whitelist = ['data-testid', 'data-test', 'data-role', 'aria-label', 'title', 'href', 'datetime'];
              for (var j = 0; j < whitelist.length; j++) {
                var k = whitelist[j];
                var v = el.getAttribute(k);
                if (v) attrs[k] = clean(v);
              }
            }
          } catch {}
          out.push({
            node_id: String(out.length + 1),
            selector: sel,
            tag: (el.tagName || '').toLowerCase(),
            text: text,
            href: el.getAttribute ? (el.getAttribute('href') || null) : null,
            datetime: el.getAttribute ? (el.getAttribute('datetime') || null) : null,
            title: el.getAttribute ? (el.getAttribute('title') || null) : null,
            aria_label: el.getAttribute ? (el.getAttribute('aria-label') || null) : null,
            class_list: clsList,
            attributes: attrs,
            text_length: text.length,
            depth: 0,
            sibling_index: 0
          });
        }
        var signature = Object.keys(sig).sort().slice(0, 20);
        return { page_title: title, candidates: out, selectorSignature: signature, authRequired: authRequired };
      })()
    `)) as SnapshotPayload;

    if (snapshot?.authRequired) {
      // Keep same semantics as other clis: only hard-fail when blocked.
      // For Kickstarter, we still allow returning partial when data is visible.
    }

    const selectorSignature = Array.isArray(snapshot?.selectorSignature) ? snapshot.selectorSignature : [];
    const domFingerprint = engine.buildDomFingerprintV1({ url, selectors: selectorSignature });
    const pageType = 'project_detail';
    const urlPattern = '/projects/:creator/:slug';
    const keyInput = {
      site: 'kickstarter',
      page_type: pageType,
      dom_fingerprint: domFingerprint,
      url_pattern: urlPattern,
      schema_version: 'v1',
      prompt_version: 'page_understanding_v1',
    } as const;

    const pageKey = `${pageType}:${domFingerprint}`;
    const artifactPaths =
      artifactsBaseDir && runId
        ? engine.buildLearningArtifactPaths({
            baseDir: artifactsBaseDir,
            site: 'kickstarter',
            runId,
            pageKey,
          })
        : null;

    if (artifactPaths && runId) {
      await safeWriteJson(engine, artifactPaths.rawPage, {
        url,
        page_title: snapshot?.page_title ?? '',
        candidate_count: Array.isArray(snapshot?.candidates) ? snapshot.candidates.length : 0,
      });
      await safeAppendTrace(
        engine,
        artifactPaths.engineTraceJsonl,
        engine.createEngineTraceEvent({
          run_id: runId,
          site: 'kickstarter',
          url,
          page_key: pageKey,
          stage: 'sample',
          event: 'sample-start',
          status: 'started',
          cache_status: 'na',
          input_summary: undefined,
          output_summary: undefined,
          error: null,
        }),
      );
      await safeAppendTrace(
        engine,
        artifactPaths.engineTraceJsonl,
        engine.createEngineTraceEvent({
          run_id: runId,
          site: 'kickstarter',
          url,
          page_key: pageKey,
          stage: 'sample',
          event: 'sample-succeeded',
          status: 'succeeded',
          cache_status: 'na',
          input_summary: undefined,
          output_summary: { candidate_count: Array.isArray(snapshot?.candidates) ? snapshot.candidates.length : 0 },
          error: null,
        }),
      );
      await safeWriteJson(engine, artifactPaths.domDistill, {
        summary: {
          totalCandidates: Array.isArray(snapshot?.candidates) ? snapshot.candidates.length : 0,
          keptCandidates: Array.isArray(snapshot?.candidates) ? snapshot.candidates.length : 0,
        },
        fieldHints: {},
        promptCandidates: [],
        dom_fingerprint: domFingerprint,
      });
    }

    const cacheFilePath = getRuleCacheFilePath();
    const cacheRes = await engine.readRuleCacheDetailed(cacheFilePath, keyInput);

    let selectorPlan =
      cacheRes.status === 'hit'
        ? cacheRes.entry.selector_plan
        : null;

    if (artifactPaths && runId) {
      const cacheEvent =
        cacheRes.status === 'hit'
          ? { stage: 'cache' as const, event: 'cache-hit', status: 'succeeded' as const, cache_status: 'hit' as const }
          : cacheRes.status === 'miss'
            ? { stage: 'cache' as const, event: 'cache-miss', status: 'succeeded' as const, cache_status: 'miss' as const }
            : { stage: 'cache' as const, event: cacheRes.error.type, status: 'failed' as const, cache_status: 'na' as const };

      await safeAppendTrace(
        engine,
        artifactPaths.engineTraceJsonl,
        engine.createEngineTraceEvent({
          run_id: runId,
          site: 'kickstarter',
          url,
          page_key: pageKey,
          stage: cacheEvent.stage,
          event: cacheEvent.event,
          status: cacheEvent.status,
          cache_status: cacheEvent.cache_status,
          input_summary: undefined,
          output_summary: undefined,
          error: cacheRes.status === 'error' ? { type: cacheRes.error.type, message: cacheRes.error.message } : null,
        }),
      );
    }

    let understanding: unknown | null = null;
    if (!selectorPlan) {
      if (!canUseLlm()) {
        // No cached rule and LLM disabled: keep crawl resilient; return empty extraction.
        selectorPlan = { plans: [] };
      } else {
        if (artifactPaths && runId) {
          await safeAppendTrace(
            engine,
            artifactPaths.engineTraceJsonl,
            engine.createEngineTraceEvent({
              run_id: runId,
              site: 'kickstarter',
              url,
              page_key: pageKey,
              stage: 'page_understanding',
              event: 'llm_requested',
              status: 'started',
              cache_status: 'miss',
              input_summary: { candidate_count: Array.isArray(snapshot?.candidates) ? snapshot.candidates.length : 0 },
              output_summary: undefined,
              error: null,
            }),
          );
        }

        try {
          understanding = await engine.runPageUnderstandingV1({
            fetchImpl: fetch,
            endpoint: process.env.MKT_CRAWLER_LLM_ENDPOINT as string,
            apiKey: process.env.MKT_CRAWLER_LLM_API_KEY as string,
            model: process.env.MKT_CRAWLER_LLM_MODEL as string,
            timeoutMs: process.env.MKT_CRAWLER_LLM_TIMEOUT_MS ? Number(process.env.MKT_CRAWLER_LLM_TIMEOUT_MS) : undefined,
            input: {
              site: 'kickstarter',
              url,
              page_title: snapshot?.page_title ?? '',
              page_context: 'detail',
              schema_version: 'v1',
              prompt_version: 'page_understanding_v1',
              url_pattern: urlPattern,
              core_schema: [
                { field: 'title', value_type: 'text', required: true },
                { field: 'url', value_type: 'url', required: false },
                { field: 'raw_id', value_type: 'text', required: false },
              ],
              field_hints: {},
              token_budget: 8000,
              dom_fingerprint: domFingerprint,
              candidates: Array.isArray(snapshot?.candidates) ? snapshot.candidates : [],
            },
          });

          selectorPlan = engine.buildSelectorPlanFromUnderstanding(understanding as any);
          await engine.writeRuleCache(cacheFilePath, keyInput as any, { selector_plan: selectorPlan });

          if (artifactPaths && runId) {
            await safeWriteJson(engine, artifactPaths.pageUnderstanding, understanding);
            await safeWriteJson(engine, artifactPaths.selectorPlan, selectorPlan);
            await safeAppendTrace(
              engine,
              artifactPaths.engineTraceJsonl,
              engine.createEngineTraceEvent({
                run_id: runId,
                site: 'kickstarter',
                url,
                page_key: pageKey,
                stage: 'page_understanding',
                event: 'llm_succeeded',
                status: 'succeeded',
                cache_status: 'miss',
                input_summary: undefined,
                output_summary: undefined,
                error: null,
              }),
            );
            await safeAppendTrace(
              engine,
              artifactPaths.engineTraceJsonl,
              engine.createEngineTraceEvent({
                run_id: runId,
                site: 'kickstarter',
                url,
                page_key: pageKey,
                stage: 'selector_plan',
                event: 'rule_generated',
                status: 'succeeded',
                cache_status: 'miss',
                input_summary: undefined,
                output_summary: { fields: Array.isArray((selectorPlan as any)?.plans) ? (selectorPlan as any).plans.length : 0 },
                error: null,
              }),
            );
          }
        } catch (e) {
          if (artifactPaths && runId) {
            const message = e instanceof Error ? e.message : String(e);
            await safeAppendTrace(
              engine,
              artifactPaths.engineTraceJsonl,
              engine.createEngineTraceEvent({
                run_id: runId,
                site: 'kickstarter',
                url,
                page_key: pageKey,
                stage: 'page_understanding',
                event: 'llm_failed',
                status: 'failed',
                cache_status: 'miss',
                input_summary: undefined,
                output_summary: undefined,
                error: { type: 'llm_failed', message },
              }),
            );
          }
          selectorPlan = { plans: [] };
        }
      }
    } else if (artifactPaths) {
      await safeWriteJson(engine, artifactPaths.selectorPlan, selectorPlan);
    }

    if (artifactPaths && runId) {
      await safeAppendTrace(
        engine,
        artifactPaths.engineTraceJsonl,
        engine.createEngineTraceEvent({
          run_id: runId,
          site: 'kickstarter',
          url,
          page_key: pageKey,
          stage: 'rule_execution',
          event: 'rule_execution_started',
          status: 'started',
          cache_status: cacheRes.status === 'hit' ? 'hit' : 'miss',
          input_summary: undefined,
          output_summary: undefined,
          error: null,
        }),
      );
    }

    const selectorPlanForEval = selectorPlan ?? { plans: [] };
    const exec = (await page.evaluate(`
      (function () {
        function clean(v) { return String(v || '').replace(/\\s+/g, ' ').trim(); }
        function firstText(selector) {
          try {
            var el = document.querySelector(selector);
            if (!el) return null;
            var text = clean(el.textContent || '');
            return text || null;
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
            var t = firstText(s);
            if (t) { got = t; used = s; strategy = 'selector'; break; }
          }

          if (!got) {
            for (var k = 0; k < fallback.length; k++) {
              var fs = String(fallback[k] || '').trim();
              if (!fs) continue;
              var ft = firstText(fs);
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

        // Always include url for downstream stability
        values.url = location && location.href ? String(location.href) : null;
        provenance.url = provenance.url || { strategy: 'computed' };

        return { values: values, provenance: provenance };
      })()
    `)) as ExecPayload;

    const values = exec && typeof exec === 'object' && exec.values && typeof exec.values === 'object' ? exec.values : {};
    const provenance = exec && typeof exec === 'object' && exec.provenance && typeof exec.provenance === 'object' ? exec.provenance : {};

    const core: Record<string, unknown> = {
      title: typeof values.title === 'string' ? values.title : null,
      url,
      raw_id: typeof values.raw_id === 'string' ? values.raw_id : null,
      creator_name: typeof values.creator_name === 'string' ? values.creator_name : null,
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
      site: 'kickstarter',
      page_type: pageType,
      ...core,
      extra,
    };

    if (artifactPaths) {
      await safeWriteJson(engine, artifactPaths.extractionResult, row);
      await safeWriteJson(engine, artifactPaths.qualityReport, {
        fields: [
          { field: 'title', status: core.title ? 'accepted' : 'missing', reason: core.title ? 'present' : 'missing', raw_value: core.title ?? null, normalized_value: core.title ?? null, provenance_strategy: (provenance as any)?.title?.strategy ?? null },
        ],
      });
      if (runId) {
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
            cache_status: cacheRes.status === 'hit' ? 'hit' : cacheRes.status === 'miss' ? 'miss' : 'na',
            input_summary: undefined,
            output_summary: { ok: true },
            error: null,
          }),
        );
      }
    }

    return row;
  },
});

