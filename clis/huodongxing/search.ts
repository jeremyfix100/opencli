import { AuthRequiredError, EmptyResultError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { log } from '@jackwener/opencli/logger';
import {
  buildDomFingerprint,
  collectDomLearningSnapshot,
  distillDomLearningCandidates,
  type DomLearningSnapshot,
} from '@jackwener/opencli/dom-distill';
import { traceDebug } from '@jackwener/opencli/debug-trace';
import {
  learnSelectorPlanFromSnapshot,
  readSelectorLearningCache,
  type LearnedSelectorPlan,
} from '@jackwener/opencli/selector-learning';

const DOMAIN = 'www.huodongxing.com';
const BASE_URL = 'https://www.huodongxing.com';
const DEFAULT_SEARCH_URL = BASE_URL + '/';
const MAX_LIMIT = 50;

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

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const m = value.match(/\d[\d,]*/);
    if (!m) return null;
    const n = Number(m[0].replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

type HuodongxingRow = {
  title: string | null;
  url: string | null;
  author: string | null;
  published_at: string | null;
  raw_id: string | null;
  engagement: Record<string, unknown>;
  event_time?: string | null;
  location?: string | null;
  fee?: string | null;
  organizer?: string | null;
  provenance?: Record<string, Record<string, unknown>>;
};

type LlmLearnedSelectors = LearnedSelectorPlan;
type LearnedSelectorCache = LearnedSelectorPlan;
type FieldProvenance = {
  strategy: string;
  selector?: string | null;
  matched_text?: string | null;
  confidence?: number | null;
  reason?: string | null;
};

function looksLikeNoiseText(value: string | null): boolean {
  if (!value) return true;
  const text = value.trim();
  if (!text) return true;
  if (text.length > 40 && /(首页|行业|生活|学习|找活动|专题|人气榜|下载App|精选推荐)/.test(text)) {
    return true;
  }
  if (/^(首页|行业|生活|学习|找活动|专题|人气榜|下载App|精选推荐)(\s+|$)/.test(text)) {
    return true;
  }
  return false;
}

function canUseLlmLearning(): boolean {
  return Boolean(
    process.env.MKT_CRAWLER_LLM_ENDPOINT &&
      process.env.MKT_CRAWLER_LLM_API_KEY &&
      process.env.MKT_CRAWLER_LLM_MODEL,
  );
}

function isDebugProvenanceEnabled(): boolean {
  return process.env.OPENCLI_DEBUG_PROVENANCE === '1';
}

function isSelectorSetEmpty(value: LearnedSelectorCache | null): boolean {
  if (!value) return true;
  return Object.values(value).every((fieldPlan) => !fieldPlan || fieldPlan.selectors.length === 0);
}

function getLearningArtifactsBaseDir(): string | null {
  const dir = process.env.OPENCLI_LEARNING_ARTIFACTS_DIR?.trim();
  return dir ? dir : null;
}

function makeRunId(): string {
  return 'hx_' + new Date().toISOString().replace(/[:.]/g, '-');
}

type LearningEngineModule = typeof import('mkt-learning-engine');

let cachedLearningEngineModule: LearningEngineModule | null = null;
async function loadLearningEngineForArtifacts(): Promise<LearningEngineModule> {
  if (!cachedLearningEngineModule) {
    cachedLearningEngineModule = await import('mkt-learning-engine');
  }
  return cachedLearningEngineModule;
}

async function safeWriteJson(le: LearningEngineModule, filePath: string, payload: unknown): Promise<void> {
  try {
    await le.writeArtifactJson(filePath, payload);
  } catch {
    // Must never break crawl path
  }
}

async function safeAppendTrace(
  le: LearningEngineModule,
  filePath: string,
  record: ReturnType<LearningEngineModule['createEngineTraceEvent']>,
): Promise<void> {
  try {
    await le.appendEngineTraceEvent(filePath, record);
  } catch {
    // Must never break crawl path
  }
}

async function hadSelectorLearningCacheHit(fingerprint: string): Promise<boolean> {
  const cache = await readSelectorLearningCache();
  if (!cache) return false;
  if (cache.plans?.[fingerprint] != null) return true;
  if (cache.entries?.[fingerprint] != null) return true;
  return false;
}

type LearningArtifactPaths = {
  root: string;
  rawPage: string;
  domDistill: string;
  selectorPlan: string;
  extractionResult: string;
  qualityReport: string;
  engineTraceJsonl: string;
};

type ArtifactWireState = {
  baseDir: string;
  runId: string;
  bufferedSample: {
    targetUrl: string;
    limit: number;
    startedAt: string;
    authRequired?: boolean | null;
    rawItemsCount?: number | null;
    normalizedRowsCount?: number | null;
  };
  pageKey: string | null;
  artifactPaths: LearningArtifactPaths | null;
  domFingerprint: string | null;
};

type ArtifactLearningHooks = {
  le: LearningEngineModule;
  ensureArtifactPaths: (input: { rowUrl: string; snapshot?: DomLearningSnapshot }) => Promise<void>;
  getArtifactWire: () => {
    runId: string;
    pageKey: string | null;
    artifactPaths: LearningArtifactPaths | null;
    domFingerprint: string | null;
  };
};

async function learnSelectorsWithLlm(
  page: { evaluate: (js: string) => Promise<unknown> },
  siteUrl: string,
  hooks?: ArtifactLearningHooks | null,
): Promise<LlmLearnedSelectors | null> {
  if (!canUseLlmLearning()) return null;
  if (process.env.OPENCLI_VERBOSE || process.env.DEBUG?.includes('opencli')) {
    process.stderr.write(`[huodongxing/search] llm learning attempt siteUrl=${siteUrl}\n`);
  }
  traceDebug('huodongxing/search', 'learn-selectors-start', { siteUrl });
  const snapshot = await collectDomLearningSnapshot(page);
  const fingerprint = buildDomFingerprint({
    url: snapshot.url || siteUrl,
    candidates: snapshot.candidates,
  });
  traceDebug('huodongxing/search', 'learn-selectors-snapshot', {
    siteUrl,
    fingerprint: fingerprint.slice(0, 8),
    candidateCount: snapshot.candidates.length,
  });

  if (hooks?.ensureArtifactPaths) {
    await hooks.ensureArtifactPaths({ rowUrl: siteUrl, snapshot });
  }
  const w = hooks?.getArtifactWire?.();
  const leMod = hooks?.le;
  if (w?.artifactPaths && w.pageKey && w.domFingerprint && w.runId && leMod) {
    const distilled = distillDomLearningCandidates(snapshot.candidates, {
      maxCandidates: 60,
      maxPerField: 8,
    });
    await safeAppendTrace(
      leMod,
      w.artifactPaths.engineTraceJsonl,
      leMod.createEngineTraceEvent({
        run_id: w.runId,
        site: 'huodongxing',
        url: snapshot.url || siteUrl,
        page_key: w.pageKey,
        stage: 'dom_distill',
        event: 'distill-start',
        status: 'started',
        cache_status: 'na',
        input_summary: { candidate_count: snapshot.candidates.length },
        output_summary: undefined,
        error: null,
      }),
    );
    await safeWriteJson(leMod, w.artifactPaths.domDistill, { ...distilled, dom_fingerprint: w.domFingerprint });
    await safeAppendTrace(
      leMod,
      w.artifactPaths.engineTraceJsonl,
      leMod.createEngineTraceEvent({
        run_id: w.runId,
        site: 'huodongxing',
        url: snapshot.url || siteUrl,
        page_key: w.pageKey,
        stage: 'dom_distill',
        event: 'distill-succeeded',
        status: 'succeeded',
        cache_status: 'na',
        input_summary: undefined,
        output_summary: {
          kept_candidates: distilled.summary.keptCandidates,
          total_candidates: distilled.summary.totalCandidates,
        },
        error: null,
      }),
    );
  }

  const cacheHit = hooks ? await hadSelectorLearningCacheHit(fingerprint) : false;
  const learned = await learnSelectorPlanFromSnapshot({
    site: 'huodongxing',
    fingerprint,
    snapshot,
  });

  if (w?.artifactPaths && w.pageKey && w.runId && leMod) {
    if (cacheHit) {
      await safeAppendTrace(
        leMod,
        w.artifactPaths.engineTraceJsonl,
        leMod.createEngineTraceEvent({
          run_id: w.runId,
          site: 'huodongxing',
          url: siteUrl,
          page_key: w.pageKey,
          stage: 'cache',
          event: 'cache-hit',
          status: 'succeeded',
          cache_status: 'hit',
          input_summary: undefined,
          output_summary: undefined,
          error: null,
        }),
      );
    } else {
      await safeAppendTrace(
        leMod,
        w.artifactPaths.engineTraceJsonl,
        leMod.createEngineTraceEvent({
          run_id: w.runId,
          site: 'huodongxing',
          url: siteUrl,
          page_key: w.pageKey,
          stage: 'cache',
          event: 'cache-miss',
          status: 'succeeded',
          cache_status: 'miss',
          input_summary: undefined,
          output_summary: undefined,
          error: null,
        }),
      );
      await safeAppendTrace(
        leMod,
        w.artifactPaths.engineTraceJsonl,
        leMod.createEngineTraceEvent({
          run_id: w.runId,
          site: 'huodongxing',
          url: siteUrl,
          page_key: w.pageKey,
          stage: 'llm_requested',
          event: 'llm_requested',
          status: 'started',
          cache_status: 'miss',
          input_summary: undefined,
          output_summary: undefined,
          error: null,
        }),
      );
      await safeAppendTrace(
        leMod,
        w.artifactPaths.engineTraceJsonl,
        leMod.createEngineTraceEvent({
          run_id: w.runId,
          site: 'huodongxing',
          url: siteUrl,
          page_key: w.pageKey,
          stage: 'llm_requested',
          event: learned ? 'llm_succeeded' : 'llm_failed',
          status: learned ? 'succeeded' : 'failed',
          cache_status: 'miss',
          input_summary: undefined,
          output_summary: undefined,
          error: learned ? null : { type: 'llm_failed', message: 'selector plan is null' },
        }),
      );
    }
    if (learned) {
      await safeWriteJson(leMod, w.artifactPaths.selectorPlan, learned);
      await safeAppendTrace(
        leMod,
        w.artifactPaths.engineTraceJsonl,
        leMod.createEngineTraceEvent({
          run_id: w.runId,
          site: 'huodongxing',
          url: siteUrl,
          page_key: w.pageKey,
          stage: 'rule_generated',
          event: 'rule_generated',
          status: 'succeeded',
          cache_status: cacheHit ? 'hit' : 'miss',
          input_summary: undefined,
          output_summary: { fields: Object.keys(learned) },
          error: null,
        }),
      );
    }
  }

  if (process.env.OPENCLI_VERBOSE || process.env.DEBUG?.includes('opencli')) {
    process.stderr.write(
      `[huodongxing/search] llm learning result=${learned ? 'hit' : 'miss'} fingerprint=${fingerprint.slice(0, 8)}\n`,
    );
  }
  traceDebug('huodongxing/search', 'learn-selectors-result', {
    siteUrl,
    fingerprint: fingerprint.slice(0, 8),
    hit: Boolean(learned),
    fields: learned ? Object.entries(learned).filter(([, fieldPlan]) => fieldPlan.selectors.length > 0).map(([field]) => field) : [],
  });
  return isSelectorSetEmpty(learned) ? null : learned;
}

function normalizeFieldProvenance(value: unknown): FieldProvenance | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const strategy = String(record.strategy ?? '').trim();
  if (!strategy) return null;
  return {
    strategy,
    selector: record.selector == null ? null : String(record.selector),
    matched_text: record.matched_text == null ? null : String(record.matched_text),
    confidence: typeof record.confidence === 'number' ? record.confidence : null,
    reason: record.reason == null ? null : String(record.reason),
  };
}

function isFallbackLikeDetailStrategy(strategy: string): boolean {
  const s = strategy.trim();
  if (s === 'detail_fallback' || s === 'missing') return true;
  if (s.startsWith('heuristic_')) return true;
  return false;
}

/** Fields in evaluate `provenance` that used fallback / heuristic / missing (per spec §6.3). */
function collectFallbackUsedFields(detailProvenance: Record<string, unknown>): {
  fields: string[];
  strategy_counts: Record<string, number>;
} {
  const fields: string[] = [];
  const strategy_counts: Record<string, number> = {};
  for (const [field, raw] of Object.entries(detailProvenance)) {
    const norm = normalizeFieldProvenance(raw);
    const strategy = norm?.strategy ?? '';
    if (strategy) {
      strategy_counts[strategy] = (strategy_counts[strategy] ?? 0) + 1;
      if (isFallbackLikeDetailStrategy(strategy)) fields.push(field);
    }
  }
  return { fields, strategy_counts };
}

function ruleExecutionKeyFieldsOutcome(row: HuodongxingRow): 'succeeded' | 'partial' | 'failed' {
  const titleOk = Boolean(row.title && String(row.title).trim());
  const organizerOk = Boolean(row.organizer && String(row.organizer).trim());
  if (titleOk && organizerOk) return 'succeeded';
  if (!titleOk && !organizerOk) return 'failed';
  return 'partial';
}

function attachProvenance(row: HuodongxingRow, field: string, provenance: FieldProvenance | null): void {
  if (!isDebugProvenanceEnabled() || !provenance) return;
  row.provenance = row.provenance ?? {};
  row.provenance[field] = provenance;
}

function makeFieldProvenance(strategy: string, value: string | null, selector?: string | null, reason?: string | null): FieldProvenance | null {
  if (!value) return null;
  return {
    strategy,
    selector: selector ?? null,
    matched_text: value,
    reason: reason ?? null,
    confidence: null,
  };
}

function sanitizeFieldValue(field: string, value: string | null, rowUrl: string | null): string | null {
  if (!value) return value;
  if (!looksLikeNoiseText(value)) return value;
  traceDebug('huodongxing/search', 'field-rejected', {
    rowUrl,
    field,
    reason: 'noise_text',
    value,
  });
  return null;
}

async function enrichHuodongxingDetail(
  page: { goto: (url: string) => Promise<void>; wait: (s: number) => Promise<void>; evaluate: (js: string) => Promise<unknown> },
  url: string,
  learned?: LlmLearnedSelectors | null,
  options?: { skipGoto?: boolean },
): Promise<Record<string, unknown>> {
  if (!options?.skipGoto) {
    await page.goto(url);
    try {
      await page.wait(1);
    } catch {
      // Best effort only
    }
  }

  const detail = await page.evaluate(`
    (function () {
      function clean(v) {
        return String(v || '').replace(/\\s+/g, ' ').trim();
      }
      function pickText(selectors) {
        for (var i = 0; i < selectors.length; i++) {
          var el = document.querySelector(selectors[i]);
          if (el && el.textContent) return {
            value: clean(el.textContent),
            selector: selectors[i],
            strategy: selectors === (learned.title || [])
              || selectors === (learned.organizer || [])
              || selectors === (learned.event_time || [])
              || selectors === (learned.location || [])
              || selectors === (learned.fee || [])
              || selectors === (learned.signup_text || [])
              ? 'llm_selector'
              : 'detail_fallback',
          };
        }
        return { value: '', selector: null, strategy: 'detail_fallback' };
      }
      function pickAttr(selector, attr) {
        var el = document.querySelector(selector);
        if (!el || !el.getAttribute) return { value: '', selector: null, strategy: 'detail_fallback' };
        return { value: clean(el.getAttribute(attr) || ''), selector: selector, strategy: 'detail_fallback' };
      }
      function findByLabel(labels) {
        var nodes = document.querySelectorAll('li,p,div,span,td,th');
        for (var i = 0; i < nodes.length; i++) {
          var txt = clean(nodes[i].textContent || '');
          if (!txt || txt.length > 120) continue;
          for (var j = 0; j < labels.length; j++) {
            var label = labels[j];
            var idx = txt.indexOf(label);
            if (idx < 0) continue;
            var tail = clean(txt.replace(label, '').replace(/^[:：\\-\\s]+/, ''));
            if (tail && tail !== txt) return { value: tail, selector: 'label:' + label, strategy: 'heuristic_label' };
          }
        }
        return { value: '', selector: null, strategy: 'heuristic_label' };
      }
      function firstResult(results) {
        for (var i = 0; i < results.length; i++) {
          var result = results[i];
          if (result && result.value) return result;
        }
        return { value: '', selector: null, strategy: 'missing' };
      }

      var bodyText = clean(document.body && document.body.innerText ? document.body.innerText : '');
      var signupMatch = bodyText.match(/(\\d[\\d,]*)\\s*(人报名|报名|人已报名|参加)/);
      var feeMatch = bodyText.match(/(免费|￥\\s?\\d+[\\d.]*(?:元)?|¥\\s?\\d+[\\d.]*(?:元)?|费用[:：]?\\s*[^\\n]{1,20}|票价[:：]?\\s*[^\\n]{1,20})/i);
      var rawMatch = (location.href || '').match(/\\/event\\/(\\d+)/) || (location.href || '').match(/\\/event\\/([^/?#]+)/);

      var learned = ${JSON.stringify(learned ?? {})};
      function pickFromLearned(fieldPlan) {
        if (!fieldPlan || !fieldPlan.selectors || !fieldPlan.selectors.length) {
          return { value: '', selector: null, strategy: 'llm_selector', confidence: null, reason: null };
        }
        var result = pickText(fieldPlan.selectors);
        return {
          value: result.value,
          selector: result.selector,
          strategy: 'llm_selector',
          confidence: typeof fieldPlan.confidence === 'number' ? fieldPlan.confidence : null,
          reason: fieldPlan.reason || null,
        };
      }

      var titleResult = firstResult([
        pickFromLearned(learned.title),
        pickAttr('meta[property="og:title"]', 'content'),
        pickAttr('meta[name="title"]', 'content'),
        pickText(['.hdx-details-title', '.details-title', 'h1', '.event-name', '.title', '.activity-title'])
      ]);
      var organizerResult = firstResult([
        pickFromLearned(learned.organizer),
        findByLabel(['主办方', '举办方', '组织方']),
        pickText(['.hdx-organizer', '.organizer', '[class*="organizer"]', '[class*="host"]'])
      ]);
      var eventTimeResult = firstResult([
        pickFromLearned(learned.event_time),
        findByLabel(['活动时间', '时间', '日期']),
        pickText(['.hdx-event-time', '.event-time', 'time', '[class*="time"]'])
      ]);
      var locationResult = firstResult([
        pickFromLearned(learned.location),
        findByLabel(['活动地点', '地点', '地址']),
        pickText(['.hdx-address', '.event-address', '.address', '[class*="location"]'])
      ]);
      var publishedAtResult = firstResult([
        pickAttr('meta[property="article:published_time"]', 'content'),
        pickAttr('meta[name="publishdate"]', 'content'),
        pickAttr('time', 'datetime')
      ]);
      var learnedFee = pickFromLearned(learned.fee);
      var feeResult = firstResult([
        learnedFee,
        feeMatch ? { value: clean(feeMatch[1]), selector: 'body:fee-regex', strategy: 'heuristic_regex' } : null,
        findByLabel(['费用', '票价']),
        pickText(['.hdx-fee', '[class*="fee"]'])
      ]);

      var learnedSignupText = pickFromLearned(learned.signup_text);
      var signupResult = firstResult([
        learnedSignupText,
        signupMatch ? { value: clean(signupMatch[0]), selector: 'body:signup-regex', strategy: 'heuristic_regex' } : null
      ]);
      var learnedSignupMatch = signupResult.value.match(/\\d[\\d,]*/);

      return {
        title: titleResult.value || null,
        organizer: organizerResult.value || null,
        author: organizerResult.value || null,
        event_time: eventTimeResult.value || null,
        location: locationResult.value || null,
        fee: feeResult.value || null,
        published_at: publishedAtResult.value || null,
        raw_id: rawMatch ? clean(rawMatch[1]) : null,
        signupCount: learnedSignupMatch
          ? Number((learnedSignupMatch[0] || '').replace(/,/g, ''))
          : (signupMatch ? Number((signupMatch[1] || '').replace(/,/g, '')) : null),
        provenance: {
          title: { strategy: titleResult.strategy, selector: titleResult.selector, matched_text: titleResult.value || null, confidence: titleResult.confidence || null, reason: titleResult.reason || null },
          organizer: { strategy: organizerResult.strategy, selector: organizerResult.selector, matched_text: organizerResult.value || null, confidence: organizerResult.confidence || null, reason: organizerResult.reason || null },
          event_time: { strategy: eventTimeResult.strategy, selector: eventTimeResult.selector, matched_text: eventTimeResult.value || null, confidence: eventTimeResult.confidence || null, reason: eventTimeResult.reason || null },
          location: { strategy: locationResult.strategy, selector: locationResult.selector, matched_text: locationResult.value || null, confidence: locationResult.confidence || null, reason: locationResult.reason || null },
          fee: { strategy: feeResult.strategy, selector: feeResult.selector, matched_text: feeResult.value || null, confidence: feeResult.confidence || null, reason: feeResult.reason || null },
          signup_text: { strategy: signupResult.strategy, selector: signupResult.selector, matched_text: signupResult.value || null, confidence: signupResult.confidence || null, reason: signupResult.reason || null },
        },
      };
    })()
  `) as Record<string, unknown>;

  return detail && typeof detail === 'object' ? detail : {};
}

cli({
  site: 'huodongxing',
  name: 'search',
  description: 'Search Huodongxing events (JSON-friendly fields for integrations)',
  domain: DOMAIN,
  strategy: Strategy.COOKIE,
  args: [
    { name: 'query_or_url', positional: true, required: false, help: 'Search keyword or full Huodongxing URL' },
    { name: 'limit', type: 'int', default: 20, help: 'Number of results to return' },
  ],
  columns: ['title', 'author', 'signupCount', 'event_time', 'location', 'fee', 'published_at', 'url', 'raw_id'],
  func: async (page, kwargs) => {
    const limit = normalizeLimit(kwargs.limit);
    const targetUrl = resolveSearchUrl(kwargs.query_or_url);
    const artifactsBaseDir = getLearningArtifactsBaseDir();
    const runId = artifactsBaseDir ? makeRunId() : null;
    const bufferedSample: ArtifactWireState['bufferedSample'] = {
      targetUrl,
      limit,
      startedAt: new Date().toISOString(),
    };
    const artifactWire: ArtifactWireState | null =
      artifactsBaseDir && runId
        ? {
            baseDir: artifactsBaseDir,
            runId,
            bufferedSample,
            pageKey: null,
            artifactPaths: null,
            domFingerprint: null,
          }
        : null;
    const le = artifactsBaseDir ? await loadLearningEngineForArtifacts() : null;

    async function ensureArtifactPaths(input: { rowUrl: string; snapshot?: DomLearningSnapshot }): Promise<void> {
      if (!artifactWire?.baseDir || !artifactWire.runId || !le) return;
      if (artifactWire.artifactPaths && artifactWire.pageKey && artifactWire.domFingerprint) return;

      let fp: string | null = null;
      if (input.snapshot && typeof input.snapshot === 'object') {
        const snap = input.snapshot;
        const urlForFp = typeof snap.url === 'string' && snap.url ? snap.url : input.rowUrl;
        const candidates = Array.isArray(snap.candidates) ? snap.candidates : [];
        fp = buildDomFingerprint({ url: urlForFp, candidates });
      }
      if (!fp) {
        fp = 'domfp_' + new Date().toISOString().replace(/[:.]/g, '-');
      }
      artifactWire.domFingerprint = fp;
      artifactWire.pageKey = 'unknown:' + fp;
      artifactWire.artifactPaths = le.buildLearningArtifactPaths({
        baseDir: artifactWire.baseDir,
        site: 'huodongxing',
        runId: artifactWire.runId,
        pageKey: artifactWire.pageKey,
      });

      const paths = artifactWire.artifactPaths;
      const bs = artifactWire.bufferedSample;

      await safeWriteJson(le, paths.rawPage, {
        targetUrl: bs.targetUrl,
        limit: bs.limit,
        authRequired: bs.authRequired ?? null,
        rawItemsCount: bs.rawItemsCount ?? null,
        normalizedRowsCount: bs.normalizedRowsCount ?? null,
      });
      await safeAppendTrace(
        le,
        paths.engineTraceJsonl,
        le.createEngineTraceEvent({
          run_id: artifactWire.runId,
          site: 'huodongxing',
          url: bs.targetUrl,
          page_key: artifactWire.pageKey,
          stage: 'sample',
          event: 'sample-start',
          status: 'started',
          cache_status: 'na',
          input_summary: { limit: bs.limit },
          output_summary: undefined,
          error: null,
        }),
      );

      if (bs.rawItemsCount != null || bs.normalizedRowsCount != null) {
        await safeAppendTrace(
          le,
          paths.engineTraceJsonl,
          le.createEngineTraceEvent({
            run_id: artifactWire.runId,
            site: 'huodongxing',
            url: bs.targetUrl,
            page_key: artifactWire.pageKey,
            stage: 'sample',
            event: 'sample-succeeded',
            status: 'succeeded',
            cache_status: 'na',
            input_summary: undefined,
            output_summary: {
              raw_items: bs.rawItemsCount ?? null,
              normalized_rows: bs.normalizedRowsCount ?? null,
              auth_required: bs.authRequired ?? null,
            },
            error: null,
          }),
        );
      }
    }

    log.info(`[huodongxing/search] start url=${targetUrl} limit=${limit}`);
    log.info(`[huodongxing/search] llm env=${canUseLlmLearning() ? 'enabled' : 'disabled'}`);
    traceDebug('huodongxing/search', 'start', { targetUrl, limit, llmEnabled: canUseLlmLearning() });

    await page.goto(targetUrl);
    try {
      await page.wait(1);
    } catch {
      // Some browser/extension runtimes may fail DOM-stability probes.
      // Keep the command resilient and continue with direct extraction.
    }

    const payload = await page.evaluate(`
      (function () {
        function clean(v) {
          return String(v || '').replace(/\\s+/g, ' ').trim();
        }
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

        var body = document.body;
        var bodyText = clean(body && body.innerText ? body.innerText : '');
        var authRequired = /log in|sign in|please sign in|please log in|captcha|verify|verification|risk|风控|登录|验证/i.test(bodyText);

        var cards = document.querySelectorAll('a[href*="/event/"]');
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
              || anchor.textContent,
          );
          var author = firstText(card, ['[class*="organizer"]', '[class*="host"]', '[class*="publisher"]']);
          var publishedAt = firstAttr(card, ['time'], 'datetime') || firstText(card, ['time']);
          var signupText = firstText(card, ['[class*="signup"]', '[class*="报名"]', '[class*="join"]']);
          var signupMatch = signupText.match(/\\d+[\\d,]*/);
          var signupCount = signupMatch ? Number(signupMatch[0].replace(/,/g, '')) : null;
          var rawMatch = url.match(/\\/event\\/(\\d+)/) || url.match(/\\/event\\/([^/?#]+)/);
          var rawId = rawMatch ? clean(rawMatch[1]) : '';

          if (!title && !url) continue;

          items.push({
            title: title || null,
            url: url || null,
            author: author || null,
            published_at: publishedAt || null,
            raw_id: rawId || null,
            engagement: signupCount != null ? { signupCount: signupCount } : {},
          });

          if (items.length >= ${limit}) break;
        }

        return { authRequired: authRequired, items: items };
      })()
    `) as {
      authRequired?: boolean;
      items?: Array<Record<string, unknown>>;
    };

    const rawItems = Array.isArray(payload?.items) ? payload.items : [];
    log.info(
      `[huodongxing/search] list page authRequired=${Boolean(payload?.authRequired)} rawItems=${rawItems.length} target=${targetUrl}`,
    );
    const items = rawItems
      .map((item) => ({
        title: typeof item.title === 'string' ? item.title : null,
        url: toAbsoluteUrl(item.url),
        author: typeof item.author === 'string' ? item.author : null,
        published_at: typeof item.published_at === 'string' ? item.published_at : null,
        raw_id: item.raw_id == null ? null : String(item.raw_id),
        engagement: typeof item.engagement === 'object' && item.engagement != null ? item.engagement : {},
      }) as HuodongxingRow)
      .filter((item) => Boolean(item.title || item.url));
    log.info(`[huodongxing/search] normalized rows=${items.length}`);
    traceDebug('huodongxing/search', 'list-page', {
      targetUrl,
      authRequired: Boolean(payload?.authRequired),
      rawItems: rawItems.length,
      normalizedRows: items.length,
    });

    if (artifactWire) {
      artifactWire.bufferedSample.authRequired = Boolean(payload?.authRequired);
      artifactWire.bufferedSample.rawItemsCount = rawItems.length;
      artifactWire.bufferedSample.normalizedRowsCount = items.length;
    }

    if (payload?.authRequired && items.length === 0) {
      throw new AuthRequiredError(DOMAIN, 'AuthRequired: huodongxing/search requires login or passed verification');
    }

    if (!items.length) {
      throw new EmptyResultError('huodongxing/search', 'No event records found (blocked page or selector mismatch)');
    }

    let learnedSelectors: LlmLearnedSelectors | null = null;

    for (const row of items) {
      if (!row.url) continue;
      try {
        let didArtifactWarmupGoto = false;
        if (artifactWire && !artifactWire.artifactPaths && row.url && !canUseLlmLearning()) {
          await page.goto(row.url);
          try {
            await page.wait(1);
          } catch {
            // Best effort only
          }
          const snapshot = await collectDomLearningSnapshot(page);
          await ensureArtifactPaths({ rowUrl: row.url, snapshot });
          didArtifactWarmupGoto = true;
        }

        if (!learnedSelectors && canUseLlmLearning()) {
          log.info(`[huodongxing/search] learning selectors from first detail row=${row.url}`);
          traceDebug('huodongxing/search', 'learn-selectors-branch', { rowUrl: row.url });
          await page.goto(row.url);
          try {
            await page.wait(1);
          } catch {
            // Best effort only
          }
          learnedSelectors = await learnSelectorsWithLlm(
            page,
            row.url,
            artifactWire && le
              ? {
                  le,
                  ensureArtifactPaths,
                  getArtifactWire: () => ({
                    runId: artifactWire.runId,
                    pageKey: artifactWire.pageKey,
                    artifactPaths: artifactWire.artifactPaths,
                    domFingerprint: artifactWire.domFingerprint,
                  }),
                }
              : undefined,
          );
          log.info(
            `[huodongxing/search] selector learning result=${learnedSelectors ? 'hit' : 'miss'} row=${row.url}`,
          );
          traceDebug('huodongxing/search', 'learn-selectors-done', { rowUrl: row.url, hit: Boolean(learnedSelectors) });
        }

        log.verbose(`[huodongxing/search] enrich detail row=${row.url} learned=${Boolean(learnedSelectors)}`);
        traceDebug('huodongxing/search', 'detail-start', { rowUrl: row.url, learned: Boolean(learnedSelectors) });
        const detail = await enrichHuodongxingDetail(page, row.url, learnedSelectors, {
          skipGoto: Boolean(learnedSelectors) || didArtifactWarmupGoto,
        });
        const detailTitle = typeof detail.title === 'string' ? detail.title : null;
        const detailPublishedAt = typeof detail.published_at === 'string' ? detail.published_at : null;
        const detailRawId = detail.raw_id == null ? null : String(detail.raw_id);
        const detailEventTime = typeof detail.event_time === 'string' ? detail.event_time : null;
        const detailLocation = typeof detail.location === 'string' ? detail.location : null;
        const detailFee = typeof detail.fee === 'string' ? detail.fee : null;
        const detailOrganizer = sanitizeFieldValue('organizer', typeof detail.organizer === 'string' ? detail.organizer : null, row.url);
        const detailAuthor = sanitizeFieldValue('author', typeof detail.author === 'string' ? detail.author : null, row.url);
        const detailSignupCount = readNumber(detail.signupCount);
        const detailProvenanceRecord =
          detail.provenance && typeof detail.provenance === 'object'
            ? (detail.provenance as Record<string, unknown>)
            : {};

        if ((!row.title || looksLikeNoiseText(row.title)) && detailTitle) row.title = detailTitle;
        if ((!row.author || looksLikeNoiseText(row.author)) && detailAuthor) row.author = detailAuthor;
        if (!row.published_at && detailPublishedAt) row.published_at = detailPublishedAt;
        if (!row.raw_id && detailRawId) row.raw_id = detailRawId;
        if (detailEventTime) row.event_time = detailEventTime;
        if (detailLocation) row.location = detailLocation;
        if (detailFee) row.fee = detailFee;
        if (detailOrganizer) row.organizer = detailOrganizer;
        if (detailTitle && (!row.provenance?.title || row.provenance.title.strategy !== 'list_page_guess')) {
          attachProvenance(row, 'title', normalizeFieldProvenance(detailProvenanceRecord.title) ?? makeFieldProvenance(learnedSelectors ? 'llm_selector' : 'detail_fallback', detailTitle));
        }
        if (detailOrganizer) {
          attachProvenance(row, 'organizer', normalizeFieldProvenance(detailProvenanceRecord.organizer) ?? makeFieldProvenance(learnedSelectors ? 'llm_selector' : 'detail_fallback', detailOrganizer));
          attachProvenance(row, 'author', normalizeFieldProvenance(detailProvenanceRecord.organizer) ?? makeFieldProvenance(learnedSelectors ? 'llm_selector' : 'detail_fallback', detailOrganizer));
        } else if (typeof detail.organizer === 'string' && looksLikeNoiseText(detail.organizer)) {
          attachProvenance(row, 'organizer', {
            strategy: 'rejected_noise',
            matched_text: detail.organizer,
            selector: null,
            confidence: null,
            reason: 'noise_text',
          });
        }
        if (detailEventTime) {
          attachProvenance(row, 'event_time', normalizeFieldProvenance(detailProvenanceRecord.event_time) ?? makeFieldProvenance(learnedSelectors ? 'llm_selector' : 'detail_fallback', detailEventTime));
        }
        if (detailLocation) {
          attachProvenance(row, 'location', normalizeFieldProvenance(detailProvenanceRecord.location) ?? makeFieldProvenance(learnedSelectors ? 'llm_selector' : 'detail_fallback', detailLocation));
        }
        if (detailFee) {
          attachProvenance(row, 'fee', normalizeFieldProvenance(detailProvenanceRecord.fee) ?? makeFieldProvenance(learnedSelectors ? 'llm_selector' : 'detail_fallback', detailFee));
        }

        if (detailSignupCount != null) {
          row.engagement = {
            ...row.engagement,
            signupCount: detailSignupCount,
          };
        }

        if (artifactWire?.artifactPaths && artifactWire.pageKey && artifactWire.runId && le) {
          await safeAppendTrace(
            le,
            artifactWire.artifactPaths.engineTraceJsonl,
            le.createEngineTraceEvent({
              run_id: artifactWire.runId,
              site: 'huodongxing',
              url: row.url!,
              page_key: artifactWire.pageKey,
              stage: 'rule_execution',
              event: 'rule_execution_started',
              status: 'started',
              cache_status: 'na',
              input_summary: { learned: Boolean(learnedSelectors) },
              output_summary: undefined,
              error: null,
            }),
          );

          const fallbackMeta = collectFallbackUsedFields(detailProvenanceRecord);
          if (fallbackMeta.fields.length > 0) {
            await safeAppendTrace(
              le,
              artifactWire.artifactPaths.engineTraceJsonl,
              le.createEngineTraceEvent({
                run_id: artifactWire.runId,
                site: 'huodongxing',
                url: row.url!,
                page_key: artifactWire.pageKey,
                stage: 'rule_execution',
                event: 'fallback_used',
                status: 'succeeded',
                cache_status: 'na',
                input_summary: undefined,
                output_summary: {
                  fields: fallbackMeta.fields,
                  strategy_counts: fallbackMeta.strategy_counts,
                },
                error: null,
              }),
            );
          }

          const keyOutcome = ruleExecutionKeyFieldsOutcome(row);
          const outcomeEvent =
            keyOutcome === 'succeeded'
              ? 'rule_execution_succeeded'
              : keyOutcome === 'partial'
                ? 'rule_execution_partial'
                : 'rule_execution_failed';
          const outcomeStatus: 'succeeded' | 'failed' = keyOutcome === 'failed' ? 'failed' : 'succeeded';
          await safeAppendTrace(
            le,
            artifactWire.artifactPaths.engineTraceJsonl,
            le.createEngineTraceEvent({
              run_id: artifactWire.runId,
              site: 'huodongxing',
              url: row.url!,
              page_key: artifactWire.pageKey,
              stage: 'rule_execution',
              event: outcomeEvent,
              status: outcomeStatus,
              cache_status: 'na',
              input_summary: undefined,
              output_summary: {
                title_present: Boolean(row.title && String(row.title).trim()),
                organizer_present: Boolean(row.organizer && String(row.organizer).trim()),
              },
              error:
                keyOutcome === 'failed'
                  ? { type: 'key_fields_missing', message: 'title and organizer both missing after detail enrich' }
                  : null,
            }),
          );

          await safeWriteJson(le, artifactWire.artifactPaths.extractionResult, { rowUrl: row.url, detail });

          const provenanceForQuality = row.provenance ?? {};
          const organizerP = provenanceForQuality.organizer as FieldProvenance | undefined;
          const organizerRejected = Boolean(organizerP && organizerP.strategy === 'rejected_noise');
          const organizerMissing = !row.organizer;
          const rejected = organizerRejected || organizerMissing;

          await safeWriteJson(le, artifactWire.artifactPaths.qualityReport, {
            rowUrl: row.url,
            fields: [
              {
                field: 'organizer',
                status: organizerRejected ? 'rejected_noise' : organizerMissing ? 'missing' : 'accepted',
                reason: organizerRejected ? 'noise_text' : organizerMissing ? 'missing' : 'ok',
                raw_value: organizerP?.matched_text ?? null,
                normalized_value: row.organizer ?? null,
                provenance_strategy: organizerP?.strategy ?? null,
              },
            ],
          });
          const organizerQualityReason: 'ok' | 'missing' | 'rejected_noise' = organizerRejected
            ? 'rejected_noise'
            : organizerMissing
              ? 'missing'
              : 'ok';
          await safeAppendTrace(
            le,
            artifactWire.artifactPaths.engineTraceJsonl,
            le.createEngineTraceEvent({
              run_id: artifactWire.runId,
              site: 'huodongxing',
              url: row.url!,
              page_key: artifactWire.pageKey,
              stage: 'quality_check',
              event: 'quality-check',
              status: 'succeeded',
              cache_status: 'na',
              input_summary: undefined,
              output_summary: {
                organizer_rejected: organizerRejected,
                organizer_missing: organizerMissing,
                reason: organizerQualityReason,
              },
              error: null,
            }),
          );
          if (rejected) {
            const qualityRejectedReason: 'missing' | 'rejected_noise' = organizerRejected
              ? 'rejected_noise'
              : 'missing';
            await safeAppendTrace(
              le,
              artifactWire.artifactPaths.engineTraceJsonl,
              le.createEngineTraceEvent({
                run_id: artifactWire.runId,
                site: 'huodongxing',
                url: row.url!,
                page_key: artifactWire.pageKey,
                stage: 'quality_check',
                event: 'quality_rejected',
                status: 'succeeded',
                cache_status: 'na',
                input_summary: undefined,
                output_summary: { field: 'organizer', reason: qualityRejectedReason },
                error: null,
              }),
            );
          }
        }

        traceDebug('huodongxing/search', 'detail-result', {
          rowUrl: row.url,
          title: row.title,
          author: row.author,
          organizer: row.organizer ?? null,
          event_time: row.event_time ?? null,
          location: row.location ?? null,
          fee: row.fee ?? null,
          signupCount: detailSignupCount,
          provenance: row.provenance ?? null,
        });
      } catch (error) {
        // Detail enrichment is best-effort; keep base row.
        log.debug(`[huodongxing/search] detail enrichment failed row=${row.url}`);
        traceDebug('huodongxing/search', 'detail-enrichment-failed', {
          rowUrl: row.url,
          error: error instanceof Error ? error.message : String(error),
        });
        if (artifactWire?.artifactPaths && artifactWire.pageKey && artifactWire.runId && le && row.url) {
          const message = error instanceof Error ? error.message : String(error);
          await safeAppendTrace(
            le,
            artifactWire.artifactPaths.engineTraceJsonl,
            le.createEngineTraceEvent({
              run_id: artifactWire.runId,
              site: 'huodongxing',
              url: row.url,
              page_key: artifactWire.pageKey,
              stage: 'rule_execution',
              event: 'rule_execution_failed',
              status: 'failed',
              cache_status: 'na',
              input_summary: { learned: Boolean(learnedSelectors) },
              output_summary: undefined,
              error: { type: 'detail_enrichment_failed', message },
            }),
          );
        }
      }
    }

    for (const row of items) {
      if (row.title && !looksLikeNoiseText(row.title)) {
        attachProvenance(row, 'title', row.provenance?.title as FieldProvenance ?? makeFieldProvenance('list_page_guess', row.title));
      }
      if (row.author && !looksLikeNoiseText(row.author)) {
        attachProvenance(row, 'author', row.provenance?.author as FieldProvenance ?? makeFieldProvenance('list_page_guess', row.author));
      }
      row.author = sanitizeFieldValue('author', row.author, row.url);
      row.organizer = sanitizeFieldValue('organizer', row.organizer ?? null, row.url);
      if (!isDebugProvenanceEnabled()) {
        delete row.provenance;
      }
    }

    log.info(`[huodongxing/search] done rows=${items.length}`);

    if (artifactWire?.artifactPaths && artifactWire.pageKey && artifactWire.runId && le) {
      await safeAppendTrace(
        le,
        artifactWire.artifactPaths.engineTraceJsonl,
        le.createEngineTraceEvent({
          run_id: artifactWire.runId,
          site: 'huodongxing',
          url: bufferedSample.targetUrl,
          page_key: artifactWire.pageKey,
          stage: 'completed',
          event: 'completed',
          status: 'succeeded',
          cache_status: 'na',
          input_summary: undefined,
          output_summary: { rows: items.length },
          error: null,
        }),
      );
    }

    return items;
  },
});

export const __test__ = {
  MAX_LIMIT,
  normalizeLimit,
  resolveSearchUrl,
  toAbsoluteUrl,
  canUseLlmLearning,
};
