import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { cli, Strategy } from '@jackwener/opencli/registry';
import type { IPage } from '@jackwener/opencli/types';

const DOMAIN = 'www.huodongxing.com';
const BASE_URL = 'https://www.huodongxing.com';

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

function sha1Hex(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex');
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

function getArtifactsBaseDir(): string | null {
  const dir = process.env.OPENCLI_LEARNING_ARTIFACTS_DIR?.trim();
  return dir ? dir : null;
}

function getPageTypeFromEnv(): string {
  const overridden = process.env.OPENCLI_HUODONGXING_PAGE_TYPE?.trim();
  return overridden && overridden.length > 0 ? overridden : 'event_list';
}

function normalizeLimit(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(n)) return 50;
  return Math.max(1, Math.min(5000, Math.floor(n)));
}

function isEventsListUrl(inputUrl: string): boolean {
  try {
    const u = new URL(inputUrl);
    return u.hostname === DOMAIN && /\/events\b/i.test(u.pathname);
  } catch {
    return false;
  }
}

function isSearchListUrl(inputUrl: string): boolean {
  try {
    const u = new URL(inputUrl);
    return u.hostname === DOMAIN && /\/search\b/i.test(u.pathname);
  } catch {
    return false;
  }
}

function getPagingParamName(inputUrl: string): 'page' | 'pi' | null {
  if (isEventsListUrl(inputUrl)) return 'page';
  if (isSearchListUrl(inputUrl)) return 'pi';
  return null;
}

function getPageNumberFromUrl(inputUrl: string, paramName: 'page' | 'pi'): number {
  try {
    const u = new URL(inputUrl);
    const raw = u.searchParams.get(paramName);
    const n = raw ? Number(raw) : NaN;
    if (!Number.isFinite(n)) return paramName === 'pi' ? 0 : 1;
    const floor = Math.floor(n);
    if (paramName === 'pi') return Math.max(0, floor);
    return Math.max(1, floor);
  } catch {
    return paramName === 'pi' ? 0 : 1;
  }
}

function withListPageNumber(inputUrl: string, paramName: 'page' | 'pi', pageNo: number): string {
  try {
    const u = new URL(inputUrl);
    const next = paramName === 'pi' ? Math.max(0, Math.floor(pageNo)) : Math.max(1, Math.floor(pageNo));
    u.searchParams.set(paramName, String(next));
    return u.toString();
  } catch {
    return inputUrl;
  }
}

async function safeWriteJson(engine: typeof import('mkt-learning-engine'), filePath: string, payload: unknown): Promise<void> {
  try {
    await engine.writeArtifactJson(filePath, payload);
  } catch {
    // best-effort only
  }
}

async function safeWriteText(filePath: string, content: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
  } catch {
    // best-effort only
  }
}

type ListItem = {
  rank: number;
  title: string | null;
  url: string;
  cover_image_url: string | null;
  raw_payload: Record<string, unknown>;
};

type ListEvalPayload = {
  authRequired?: boolean;
  items?: Array<Record<string, unknown>>;
  itemCount?: number;
};

async function evalHuodongxingList(page: IPage, opts: { limit: number }): Promise<ListEvalPayload> {
  return (await page.evaluate(`
    (function () {
      function clean(v) { return String(v || '').replace(/\\s+/g, ' ').trim(); }
      function pickText(root, selectors) {
        for (var i = 0; i < selectors.length; i++) {
          var el = root && root.querySelector ? root.querySelector(selectors[i]) : null;
          var t = el && el.textContent ? clean(el.textContent) : '';
          if (t) return t;
        }
        return '';
      }
      function pickAttr(root, selectors, attr) {
        for (var i = 0; i < selectors.length; i++) {
          var el = root && root.querySelector ? root.querySelector(selectors[i]) : null;
          if (!el) continue;
          var v = '';
          if (attr === 'href' && el.href) v = clean(el.href);
          else if (attr === 'src') v = clean((el.currentSrc || '') || (el.getAttribute && el.getAttribute('src')) || '');
          else if (el.getAttribute) v = clean(el.getAttribute(attr) || '');
          if (v) return v;
        }
        return '';
      }

      var bodyText = clean(document.body && document.body.innerText ? document.body.innerText : '');
      var authRequired = /log in|sign in|please sign in|please log in|captcha|verify|verification|risk|风控|登录|验证/i.test(bodyText);

      var anchors = document.querySelectorAll('a[href*=\"/event/\"]');
      var dedupe = Object.create(null);
      var items = [];

      for (var i = 0; i < anchors.length; i++) {
        var a = anchors[i];
        var href = (a.getAttribute && a.getAttribute('href')) || '';
        var url = a.href || href || '';
        if (!url) continue;
        if (dedupe[url]) continue;
        dedupe[url] = true;

        var root = null;
        try { root = a.closest && a.closest('li, article, .search-item, .event-item, .item, .list-item, .event-card, .card'); } catch (e) { root = null; }
        root = root || a;

        var title = clean((a.getAttribute && a.getAttribute('title')) || '') || pickText(root, ['.title', '.name', '.event-title', 'h1', 'h2', 'h3', 'h4']) || clean(a.textContent || '');
        var cover = pickAttr(root, ['img', '.cover img', '.pic img', '.img img', '.event-img img'], 'src') || '';
        var time = pickText(root, ['.time', '.date', '.event-time', '.event_date', '.datetime', 'time']);
        var location = pickText(root, ['.address', '.location', '.city', '.place', '.event-address', '.event_location']);
        var cost = pickText(root, ['.price', '.cost', '.fee', '.event-price', '.money']);
        var organizer = pickText(root, ['.organizer', '.org', '.host', '.sponsor', '.company', '.event-org']);

        items.push({
          title: title || null,
          url: url,
          cover_image_url: cover || null,
          event_time: time || null,
          location: location || null,
          cost: cost || null,
          organizer: organizer || null
        });
        if (items.length >= ${opts.limit}) break;
      }

      return { authRequired: authRequired, itemCount: anchors.length, items: items };
    })()
  `)) as ListEvalPayload;
}

cli({
  site: 'huodongxing',
  name: 'list',
  description: 'Huodongxing list-only collector (events/search list → items only)',
  domain: DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'url', positional: true, required: true, help: 'Huodongxing list URL (/events or /search)' },
    { name: 'limit', type: 'int', default: 50, help: 'Max items to collect (max 5000)' },
  ],
  columns: ['url', 'site', 'page_type', 'items_count'],
  func: async (page: IPage, kwargs) => {
    const rawUrl = String(kwargs.url ?? '').trim();
    const limit = normalizeLimit(kwargs.limit);
    const u = new URL(rawUrl);
    if (u.hostname !== DOMAIN) {
      throw new Error(`Invalid host: ${u.hostname}. Expected ${DOMAIN}`);
    }

    const pageType = getPageTypeFromEnv();
    const artifactsBaseDir = getArtifactsBaseDir();
    const opencliRunId = artifactsBaseDir ? `hx_list_${nowIsoUtc8().replace(/[:.]/g, '-')}` : null;
    const urlPattern = `${u.origin}${u.pathname}`;
    const pageKeyHash = sha1Hex(`huodongxing|${pageType}|${urlPattern}`).slice(0, 10);
    const pageKey = safeSlice(`${sanitizeToken(pageType, 'page')}___huodongxing___${sanitizeToken(u.pathname, 'path')}___${pageKeyHash}`, 160);

    const engine = await import('mkt-learning-engine');
    const artifactPaths =
      artifactsBaseDir && opencliRunId
        ? engine.buildLearningArtifactPaths({
            baseDir: artifactsBaseDir,
            site: 'huodongxing',
            runId: opencliRunId,
            pageKey,
          })
        : null;

    const pagingParamName = getPagingParamName(u.toString());
    const enablePagination = pagingParamName != null;
    const startPageNo = enablePagination ? getPageNumberFromUrl(u.toString(), pagingParamName!) : 1;
    const maxPages = enablePagination ? 200 : 1;

    const seen = new Set<string>();
    const items: ListItem[] = [];
    let authRequired = false;
    let pagesWithoutNew = 0;

    for (let i = 0; i < maxPages; i++) {
      if (items.length >= limit) break;
      if (pagesWithoutNew >= 5) break;

      const pageNo = startPageNo + i;
      const listUrl = enablePagination ? withListPageNumber(u.toString(), pagingParamName!, pageNo) : u.toString();
      await page.goto(listUrl);
      try {
        await page.wait(1);
      } catch {}
      try {
        await page.autoScroll({ times: 2, delayMs: 250 });
      } catch {}
      try {
        await page.wait(1);
      } catch {}

      const payload = await evalHuodongxingList(page, { limit: Math.max(100, Math.min(limit, 5000)) });
      if (payload.authRequired) {
        authRequired = true;
        break;
      }

      const rows = Array.isArray(payload.items) ? payload.items : [];
      const before = items.length;
      for (const row of rows) {
        if (items.length >= limit) break;
        const url = typeof (row as any).url === 'string' ? String((row as any).url).trim() : '';
        if (!url) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        items.push({
          rank: items.length + 1,
          title: typeof (row as any).title === 'string' ? String((row as any).title).trim() : null,
          url,
          cover_image_url: typeof (row as any).cover_image_url === 'string' ? String((row as any).cover_image_url).trim() : null,
          raw_payload: {
            list_url: listUrl,
            event_time: (row as any).event_time ?? null,
            location: (row as any).location ?? null,
            cost: (row as any).cost ?? null,
            organizer: (row as any).organizer ?? null,
          },
        });
      }
      if (items.length <= before) pagesWithoutNew += 1;
      else pagesWithoutNew = 0;

      // For /events, there may be a finite page count; stop early if no pagination detected.
      if (!enablePagination) break;
    }

    if (artifactPaths) {
      await safeWriteJson(engine, artifactPaths.rawPage, {
        site: 'huodongxing',
        page_type: pageType,
        url: u.toString(),
        url_pattern: urlPattern,
        snapshots_saved: false,
      });
      await safeWriteJson(engine, artifactPaths.selectorPlan, {
        plan_kind: 'huodongxing_list_v1',
        url_pattern: urlPattern,
        paging_param: pagingParamName,
      });
      await safeWriteJson(engine, artifactPaths.extractionResult, {
        site: 'huodongxing',
        page_type: pageType,
        cluster: { search_url: u.toString(), url_pattern: urlPattern, collected_at: nowIsoUtc8() },
        items: items.map((it) => ({
          rank: it.rank,
          title: it.title,
          url: it.url,
          author: null,
          like_count: null,
          cover_image_url: it.cover_image_url,
          published_at: null,
          raw_payload: it.raw_payload,
        })),
      });
      // Keep a small debug snapshot in case the list is empty.
      try {
        const html = await page.evaluate('document.documentElement.outerHTML');
        await safeWriteText(path.join(artifactPaths.root, 'snapshots', 's0.html'), typeof html === 'string' ? html : String(html ?? ''));
      } catch {
        // best-effort
      }
    }

    if (authRequired) {
      throw new Error('AuthRequired: huodongxing/list requires login or passed verification');
    }

    return {
      url: u.toString(),
      site: 'huodongxing',
      page_type: pageType,
      items_count: items.length,
    };
  },
});

