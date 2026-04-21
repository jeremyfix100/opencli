import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { cli, Strategy } from '@jackwener/opencli/registry';
import type { IPage } from '@jackwener/opencli/types';

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

function shouldSaveHtmlSnapshots(learningMode: string | undefined): boolean {
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

function getLearningModeFromEnv(): 'auto' | 'llm_only' | 'cache_only' | undefined {
  const raw = process.env.OPENCLI_GENERIC_LEARNING_MODE?.trim();
  if (!raw) return undefined;
  if (raw === 'auto' || raw === 'llm_only' || raw === 'cache_only') return raw;
  return undefined;
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

function readOptionalIntFromEnv(key: string): number | null {
  const raw = process.env[key]?.trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
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

function normalizeLikeCount(raw: unknown): { value: number | null; raw: string | null } {
  if (raw === null || raw === undefined) return { value: null, raw: null };
  if (typeof raw === 'number' && Number.isFinite(raw)) return { value: Math.max(0, Math.floor(raw)), raw: String(raw) };
  const s = String(raw).trim();
  if (!s) return { value: null, raw: null };
  const clean = s.replace(/[,\\s]/g, '').replace(/赞|likes?/gi, '').toLowerCase();
  // 支持 1.2w / 1.2万
  const mWan = clean.match(/^(\d+(?:\.\d+)?)\s*万$/);
  if (mWan) return { value: Math.floor(Number(mWan[1]) * 10000), raw: s };
  const mW = clean.match(/^(\d+(?:\.\d+)?)\s*w$/);
  if (mW) return { value: Math.floor(Number(mW[1]) * 10000), raw: s };
  const mQian = clean.match(/^(\d+(?:\.\d+)?)\s*千$/);
  if (mQian) return { value: Math.floor(Number(mQian[1]) * 1000), raw: s };
  const mK = clean.match(/^(\d+(?:\.\d+)?)\s*k$/);
  if (mK) return { value: Math.floor(Number(mK[1]) * 1000), raw: s };
  const n = Number(clean);
  if (Number.isFinite(n)) return { value: Math.max(0, Math.floor(n)), raw: s };
  return { value: null, raw: s };
}

function isoUtc8FromMs(ms: number): string {
  const shifted = new Date(ms + 8 * 60 * 60 * 1000);
  const Y = shifted.getUTCFullYear();
  const M = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const D = String(shifted.getUTCDate()).padStart(2, '0');
  const h = String(shifted.getUTCHours()).padStart(2, '0');
  const m = String(shifted.getUTCMinutes()).padStart(2, '0');
  const s = String(shifted.getUTCSeconds()).padStart(2, '0');
  return `${Y}-${M}-${D}T${h}:${m}:${s}.000+08:00`;
}

function isoUtc8DateFromParts(input: { Y: number; M: number; D: number; h?: number; m?: number }): string | null {
  const Y = input.Y;
  const M = input.M;
  const D = input.D;
  if (!Number.isFinite(Y) || !Number.isFinite(M) || !Number.isFinite(D)) return null;
  if (M < 1 || M > 12) return null;
  if (D < 1 || D > 31) return null;
  const h = input.h ?? 0;
  const m = input.m ?? 0;
  if (h < 0 || h > 23) return null;
  if (m < 0 || m > 59) return null;
  const MM = String(M).padStart(2, '0');
  const DD = String(D).padStart(2, '0');
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return `${Y}-${MM}-${DD}T${hh}:${mm}:00.000+08:00`;
}

function normalizePublishedAt(raw: unknown): { iso: string | null; raw: string | null } {
  if (raw === null || raw === undefined) return { iso: null, raw: null };
  const s = String(raw).trim();
  if (!s) return { iso: null, raw: null };
  const nowMs = Date.now();
  const normalized = s.replace(/\\s+/g, ' ').trim();

  // Relative (CN)
  if (normalized === '刚刚' || normalized.toLowerCase() === 'just now') {
    return { iso: isoUtc8FromMs(nowMs), raw: s };
  }
  const mMin = normalized.match(/^(\d{1,3})\\s*分钟(?:前)?$/);
  if (mMin) return { iso: isoUtc8FromMs(nowMs - Number(mMin[1]) * 60 * 1000), raw: s };
  const mHour = normalized.match(/^(\d{1,3})\\s*小时(?:前)?$/);
  if (mHour) return { iso: isoUtc8FromMs(nowMs - Number(mHour[1]) * 60 * 60 * 1000), raw: s };
  const mDay = normalized.match(/^(\d{1,3})\\s*天(?:前)?$/);
  if (mDay) return { iso: isoUtc8FromMs(nowMs - Number(mDay[1]) * 24 * 60 * 60 * 1000), raw: s };
  const mWeek = normalized.match(/^(\d{1,3})\\s*周(?:前)?$/);
  if (mWeek) return { iso: isoUtc8FromMs(nowMs - Number(mWeek[1]) * 7 * 24 * 60 * 60 * 1000), raw: s };
  const mMonth = normalized.match(/^(\d{1,3})\\s*个月(?:前)?$/);
  if (mMonth) return { iso: isoUtc8FromMs(nowMs - Number(mMonth[1]) * 30 * 24 * 60 * 60 * 1000), raw: s };
  const mYear = normalized.match(/^(\d{1,3})\\s*年(?:前)?$/);
  if (mYear) return { iso: isoUtc8FromMs(nowMs - Number(mYear[1]) * 365 * 24 * 60 * 60 * 1000), raw: s };

  // Yesterday / day before yesterday (optional time)
  const mYest = normalized.match(/^(昨天|前天)(?:\\s*(\\d{1,2}):(\\d{2}))?$/);
  if (mYest) {
    const days = mYest[1] === '昨天' ? 1 : 2;
    const h = mYest[2] ? Number(mYest[2]) : 0;
    const m = mYest[3] ? Number(mYest[3]) : 0;
    const targetMs = nowMs - days * 24 * 60 * 60 * 1000;
    const shifted = new Date(targetMs + 8 * 60 * 60 * 1000);
    const iso = isoUtc8DateFromParts({
      Y: shifted.getUTCFullYear(),
      M: shifted.getUTCMonth() + 1,
      D: shifted.getUTCDate(),
      h,
      m,
    });
    return { iso: iso ?? isoUtc8FromMs(targetMs), raw: s };
  }

  // Absolute (CN/ISO): YYYY-MM-DD (optional time)
  const mAbsY = normalized.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\\s+(\\d{1,2}):(\\d{2}))?$/);
  if (mAbsY) {
    const iso = isoUtc8DateFromParts({
      Y: Number(mAbsY[1]),
      M: Number(mAbsY[2]),
      D: Number(mAbsY[3]),
      h: mAbsY[4] ? Number(mAbsY[4]) : 0,
      m: mAbsY[5] ? Number(mAbsY[5]) : 0,
    });
    if (iso) return { iso, raw: s };
  }

  // Absolute (CN): M月D日 (optional time)
  const mMdCn = normalized.match(/^(\d{1,2})月(\d{1,2})日(?:\\s*(\\d{1,2}):(\\d{2}))?$/);
  if (mMdCn) {
    const shiftedNow = new Date(nowMs + 8 * 60 * 60 * 1000);
    const iso = isoUtc8DateFromParts({
      Y: shiftedNow.getUTCFullYear(),
      M: Number(mMdCn[1]),
      D: Number(mMdCn[2]),
      h: mMdCn[3] ? Number(mMdCn[3]) : 0,
      m: mMdCn[4] ? Number(mMdCn[4]) : 0,
    });
    if (iso) return { iso, raw: s };
  }

  // Absolute (CN): MM-DD (optional time), assume current year (UTC+8)
  const mMd = normalized.match(/^(\d{1,2})-(\d{1,2})(?:\\s*(\\d{1,2}):(\\d{2}))?$/);
  if (mMd) {
    const shiftedNow = new Date(nowMs + 8 * 60 * 60 * 1000);
    const iso = isoUtc8DateFromParts({
      Y: shiftedNow.getUTCFullYear(),
      M: Number(mMd[1]),
      D: Number(mMd[2]),
      h: mMd[3] ? Number(mMd[3]) : 0,
      m: mMd[4] ? Number(mMd[4]) : 0,
    });
    if (iso) return { iso, raw: s };
  }

  // Final fallback: Date.parse (keeps timezone if present)
  const t = Date.parse(normalized);
  if (Number.isFinite(t)) {
    return { iso: new Date(t).toISOString(), raw: s };
  }
  return { iso: null, raw: s };
}

function toAbsoluteUrlMaybe(raw: unknown, baseUrl: string): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  try {
    return new URL(s, baseUrl).toString();
  } catch {
    return null;
  }
}

async function readActiveCoreSchema(engine: typeof import('mkt-learning-engine'), input: { site: string; page_type: string; schema_variant_key: string; registryPath: string }) {
  const file = await engine.readCoreSchemaRegistryV1(input.registryPath);
  const storageKey = JSON.stringify({
    site: input.site,
    page_type: input.page_type,
    schema_variant_key: input.schema_variant_key,
  });
  const record = (file.active as any)?.[storageKey];
  const schema = record?.schema;
  if (!Array.isArray(schema) || schema.length === 0) {
    return null;
  }
  return schema as Array<{ field: string; value_type: string; required: boolean }>;
}

cli({
  site: 'generic',
  name: 'list',
  description: 'Generic list/search page collector (cache-only list plan + scroll action plan).',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [{ name: 'url', positional: true, required: true, help: 'Any http(s) URL' }],
  columns: ['url', 'site', 'page_type', 'items_count'],
  func: async (page: IPage, kwargs) => {
    const raw = String(kwargs.url ?? '').trim();
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Invalid URL protocol: ${url.protocol}`);
    }

    const virtualSite = getVirtualSiteFromEnv(url);
    const pageType = getPageTypeFromEnv();
    const learning_mode = getLearningModeFromEnv();
    const waitAfterGotoSeconds = readWaitSecondsFromEnv('OPENCLI_GENERIC_WAIT_AFTER_GOTO_SECONDS', 2);
    const waitAfterScrollSeconds = readWaitSecondsFromEnv('OPENCLI_GENERIC_WAIT_AFTER_SCROLL_SECONDS', 2);
    const maxItemsOverride = readOptionalIntFromEnv('OPENCLI_GENERIC_MAX_ITEMS');

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
        snapshots_saved: saveHtmlSnapshots,
      });
    }

    if (!learning_mode) {
      // Snapshot-only mode: used by learning flow to capture s0~s2.
      return { url: url.toString(), site: virtualSite, page_type: pageType, items_count: 0 };
    }

    const schemaRegistryFilePath = getGenericSchemaRegistryPath();
    const core_schema = await readActiveCoreSchema(engine, {
      site: virtualSite,
      page_type: pageType,
      schema_variant_key: 'default',
      registryPath: schemaRegistryFilePath,
    });
    if (!core_schema) {
      throw new Error('需要先 Learn：core_schema 缺失。请先在 /learning 学习该 list 页面。');
    }

    const cacheFilePath = getRuleCacheFilePath();
    const listRes = await engine.getOrLearnListPlanFromHtmlSnapshotsV1({
      cacheFilePath,
      site: virtualSite,
      page_type: pageType,
      url: url.toString(),
      url_pattern: urlPattern,
      schema_version: 'v1',
      prompt_version: 'list_understanding_v1',
      core_schema,
      html_snapshots,
      learning_mode,
      llm: null,
      fetchImpl: fetch,
    });

    const actionPlan = { ...listRes.action_plan, ...(maxItemsOverride ? { max_items: maxItemsOverride } : null) };
    const item_selector = listRes.list_selector_plan.item_selector;
    const listPlanEffective = (() => {
      const plan = listRes.list_selector_plan;
      const fields = Array.isArray(plan.fields) ? plan.fields : [];
      const nextFields = fields.map((f) => {
        if (!f || typeof f !== 'object') return f as any;
        if (f.field !== 'published_at') return f as any;
        const sels = Array.isArray((f as any).selectors) ? ((f as any).selectors as string[]) : [];
        const extra = [
          '.name-time-wrapper .time',
          '.author .time',
          '.author-wrapper .time',
          'a.author .time',
          'div.time',
          'span.time',
          '.time',
        ];
        const merged = Array.from(new Set([...sels, ...extra].map((s) => String(s || '').trim()).filter(Boolean)));
        return { ...(f as any), selectors: merged };
      });
      return { ...plan, fields: nextFields };
    })();

    // Execute scroll plan to expose more items.
    let settle = 0;
    let lastCount = -1;
    const settleRounds = Math.max(0, Math.floor(actionPlan.settle_rounds));
    const maxItems = actionPlan.max_items ? Math.max(1, Math.floor(actionPlan.max_items)) : null;
    const waitAfterScrollSecondsEffective =
      typeof actionPlan.wait_after_scroll_seconds === 'number' && Number.isFinite(actionPlan.wait_after_scroll_seconds)
        ? Math.max(0, actionPlan.wait_after_scroll_seconds)
        : waitAfterScrollSeconds;

    const maxRoundsFromPlan = Math.max(0, Math.floor(actionPlan.max_scroll_rounds));
    const maxRoundsFromLimit =
      maxItems && maxItems > 0 ? Math.min(200, Math.ceil(maxItems / 20) + 5) : 0; // 20 items/round heuristic
    const maxRounds = Math.max(maxRoundsFromPlan, maxRoundsFromLimit);

    const scrollOnce = async (): Promise<void> => {
      // Prefer scrolling the scrollable ancestor of the item list, otherwise fall back to document scroll.
      try {
        await page.evaluate(`
          (function () {
            try {
              var itemSel = ${JSON.stringify(item_selector)};
              var items = Array.from(document.querySelectorAll(itemSel));
              var last = items.length ? items[items.length - 1] : null;
              if (last && last.scrollIntoView) {
                try { last.scrollIntoView({ block: 'end', inline: 'nearest' }); } catch (e) { try { last.scrollIntoView(); } catch (e2) {} }
              }

              function isScrollable(el) {
                if (!el) return false;
                var style = window.getComputedStyle(el);
                var oy = (style && style.overflowY) ? String(style.overflowY) : '';
                if (oy !== 'auto' && oy !== 'scroll') return false;
                return (el.scrollHeight || 0) > (el.clientHeight || 0) + 40;
              }

              var probe = items.length ? items[0] : document.querySelector(itemSel);
              var el = probe ? probe.parentElement : null;
              while (el) {
                if (isScrollable(el)) break;
                el = el.parentElement;
              }

              if (el && isScrollable(el)) {
                try { el.scrollTop = el.scrollHeight; } catch (e3) {}
                return;
              }

              var root = document.scrollingElement || document.documentElement;
              try { root.scrollTop = root.scrollHeight; } catch (e4) {}
              try { window.scrollTo(0, document.body.scrollHeight); } catch (e5) {}
            } catch (e) {}
          })()
        `);
      } catch {}
      try {
        await page.scroll('down', 1200);
      } catch {}
    };

    const extractVisibleRaw = async (): Promise<any[]> => {
      const extracted = (await page.evaluate(`
        (function () {
          function clean(v) { return String(v || '').replace(/\\s+/g, ' ').trim(); }
          function firstWithin(root, selector, attr) {
            try {
              if (!root || !selector) return null;
              var node = root.querySelector(selector);
              if (!node) return null;
              var tag = node.tagName ? node.tagName.toLowerCase() : '';
              if (attr === 'href') {
                if (tag === 'a' && node.href) return clean(node.href) || null;
                var href = node.getAttribute && node.getAttribute('href');
                return clean(href || '') || null;
              }
              if (attr === 'src') {
                if (tag === 'img') {
                  var src = (node.currentSrc || '') || (node.getAttribute && node.getAttribute('src')) || '';
                  return clean(src) || null;
                }
                var src2 = node.getAttribute && node.getAttribute('src');
                return clean(src2 || '') || null;
              }
              if (attr === 'datetime') {
                var dt = node.getAttribute && node.getAttribute('datetime');
                return clean(dt || '') || null;
              }
              if (attr === 'content') {
                var c = node.getAttribute && node.getAttribute('content');
                return clean(c || '') || null;
              }
              // default: text
              return clean(node.textContent || '') || null;
            } catch (e) {
              return null;
            }
          }

          var itemSelector = ${JSON.stringify(item_selector)};
          var plan = ${JSON.stringify(listPlanEffective)};
          var items = [];
          var roots = [];
          try {
            roots = Array.from(document.querySelectorAll(itemSelector));
          } catch (e) {
            roots = [];
          }
          for (var i = 0; i < roots.length; i++) {
            var root = roots[i];
            var out = { rank: i + 1, fields: {}, raw: {} };
            var fields = (plan && plan.fields && Array.isArray(plan.fields)) ? plan.fields : [];
            for (var j = 0; j < fields.length; j++) {
              var f = fields[j] || {};
              var key = String(f.field || '').trim();
              if (!key) continue;
              var sels = Array.isArray(f.selectors) ? f.selectors : [];
              var attr = (typeof f.attr === 'string' && f.attr) ? f.attr : 'text';
              var got = null;
              var used = null;
              for (var k = 0; k < sels.length; k++) {
                var sel = String(sels[k] || '').trim();
                if (!sel) continue;
                var v = firstWithin(root, sel, attr);
                if (v) { got = v; used = sel; break; }
              }
              out.fields[key] = got;
              out.raw[key] = { selector: used, attr: attr, value: got };
            }
            items.push(out);
          }
          return { count: items.length, items: items };
        })()
      `)) as any;
      const itemsRaw: any[] = Array.isArray(extracted?.items) ? extracted.items : [];
      return itemsRaw;
    };

    const collected = new Map<string, any>();
    const collectFromDom = async (): Promise<number> => {
      const baseUrl = url.toString();
      const rawItems = await extractVisibleRaw();
      for (const it of rawItems) {
        const f = it && typeof it === 'object' ? (it.fields ?? {}) : {};
        const rawFields = it && typeof it === 'object' ? (it.raw ?? {}) : {};
        const title = typeof f.title === 'string' ? f.title : null;
        const urlAbs = toAbsoluteUrlMaybe(f.url, baseUrl);
        if (!urlAbs) continue;
        const author = typeof f.author === 'string' ? f.author : null;
        const cover = toAbsoluteUrlMaybe(f.cover_image_url, baseUrl);
        const like = normalizeLikeCount(f.like_count);
        const published = normalizePublishedAt(f.published_at);

        const next = {
          rank: collected.size + 1,
          title,
          url: urlAbs,
          author,
          like_count: like.value,
          cover_image_url: cover,
          published_at: published.iso,
          raw_payload: {
            fields: rawFields,
            like_count_raw: like.raw,
            published_at_raw: published.raw,
          },
        };

        const prev = collected.get(urlAbs);
        if (!prev) {
          collected.set(urlAbs, next);
          continue;
        }
        // Merge: keep earliest rank, fill missing fields.
        collected.set(urlAbs, {
          ...prev,
          title: prev.title ?? next.title,
          author: prev.author ?? next.author,
          like_count: prev.like_count ?? next.like_count,
          cover_image_url: prev.cover_image_url ?? next.cover_image_url,
          published_at: prev.published_at ?? next.published_at,
          raw_payload: prev.raw_payload ?? next.raw_payload,
        });
      }
      return collected.size;
    };

    // Always collect the first viewport before scrolling (helps with virtualized lists).
    await collectFromDom();

    for (let i = 0; i < maxRounds; i++) {
      try {
        const before = collected.size;
        if (maxItems && before >= maxItems) break;

        await scrollOnce();
        await page.wait(waitAfterScrollSecondsEffective);

        await collectFromDom();
        let after = collected.size;
        if (after <= before) {
          // Fallback: a short autoScroll can trigger IntersectionObserver-based loaders.
          try {
            await page.autoScroll({ times: 1, delayMs: Math.max(50, Math.floor(waitAfterScrollSecondsEffective * 1000)) });
          } catch {}
          try {
            await page.wait(waitAfterScrollSecondsEffective);
          } catch {}
          await collectFromDom();
          after = collected.size;
        }

        if (after <= lastCount) {
          settle += 1;
        } else {
          settle = 0;
          lastCount = after;
        }
        if (settleRounds > 0 && settle >= settleRounds) break;
      } catch {}
    }

    const itemsAll = Array.from(collected.values());
    const itemsLimited = maxItems ? itemsAll.slice(0, Math.max(1, maxItems)) : itemsAll;

    const result = {
      site: virtualSite,
      page_type: pageType,
      cluster: {
        search_url: url.toString(),
        url_pattern: urlPattern,
        collected_at: nowIsoUtc8(),
      },
      items: itemsLimited,
    };

    if (artifactPaths && opencliRunId) {
      await safeWriteJson(engine, artifactPaths.selectorPlan, {
        site: virtualSite,
        page_type: pageType,
        url: url.toString(),
        url_pattern: urlPattern,
        schema_version: 'v1',
        prompt_version: 'list_understanding_v1',
        cache_status: listRes.cache_status,
        learning_method: listRes.learning_method,
        dom_fingerprint: listRes.dom_fingerprint,
        used_snapshot_key: listRes.used_snapshot_key,
        snapshot_summaries: listRes.snapshot_summaries,
        list_selector_plan: listRes.list_selector_plan,
        action_plan: actionPlan,
      });
      await safeWriteJson(engine, artifactPaths.extractionResult, result);
    }

    return {
      url: url.toString(),
      site: virtualSite,
      page_type: pageType,
      items_count: itemsLimited.length,
    };
  },
});
