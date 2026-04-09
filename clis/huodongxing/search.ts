import { AuthRequiredError, EmptyResultError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';

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

async function enrichHuodongxingDetail(page: { goto: (url: string) => Promise<void>; wait: (s: number) => Promise<void>; evaluate: (js: string) => Promise<unknown> }, url: string): Promise<Record<string, unknown>> {
  await page.goto(url);
  try {
    await page.wait(1);
  } catch {
    // Best effort only
  }

  const detail = await page.evaluate(`
    (function () {
      function clean(v) {
        return String(v || '').replace(/\\s+/g, ' ').trim();
      }
      function pickText(selectors) {
        for (var i = 0; i < selectors.length; i++) {
          var el = document.querySelector(selectors[i]);
          if (el && el.textContent) return clean(el.textContent);
        }
        return '';
      }
      function pickAttr(selector, attr) {
        var el = document.querySelector(selector);
        if (!el || !el.getAttribute) return '';
        return clean(el.getAttribute(attr) || '');
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
            if (tail && tail !== txt) return tail;
          }
        }
        return '';
      }

      var bodyText = clean(document.body && document.body.innerText ? document.body.innerText : '');
      var signupMatch = bodyText.match(/(\\d[\\d,]*)\\s*(人报名|报名|人已报名|参加)/);
      var feeMatch = bodyText.match(/(免费|￥\\s?\\d+[\\d.]*(?:元)?|¥\\s?\\d+[\\d.]*(?:元)?|费用[:：]?\\s*[^\\n]{1,20}|票价[:：]?\\s*[^\\n]{1,20})/i);
      var rawMatch = (location.href || '').match(/\\/event\\/(\\d+)/) || (location.href || '').match(/\\/event\\/([^/?#]+)/);

      var title = pickAttr('meta[property="og:title"]', 'content')
        || pickAttr('meta[name="title"]', 'content')
        || pickText(['.hdx-details-title', '.details-title', 'h1', '.event-name', '.title', '.activity-title']);
      var organizer = findByLabel(['主办方', '举办方', '组织方']) || pickText(['.hdx-organizer', '.organizer', '[class*="organizer"]', '[class*="host"]']);
      var eventTime = findByLabel(['活动时间', '时间', '日期']) || pickText(['.hdx-event-time', '.event-time', 'time', '[class*="time"]']);
      var locationText = findByLabel(['活动地点', '地点', '地址']) || pickText(['.hdx-address', '.event-address', '.address', '[class*="location"]']);
      var publishedAt = pickAttr('meta[property="article:published_time"]', 'content')
        || pickAttr('meta[name="publishdate"]', 'content')
        || pickAttr('time', 'datetime');
      var fee = feeMatch ? clean(feeMatch[1]) : (findByLabel(['费用', '票价']) || pickText(['.hdx-fee', '[class*="fee"]']) || '');

      return {
        title: title || null,
        organizer: organizer || null,
        author: organizer || null,
        event_time: eventTime || null,
        location: locationText || null,
        fee: fee || null,
        published_at: publishedAt || null,
        raw_id: rawMatch ? clean(rawMatch[1]) : null,
        signupCount: signupMatch ? Number((signupMatch[1] || '').replace(/,/g, '')) : null,
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

    if (payload?.authRequired && items.length === 0) {
      throw new AuthRequiredError(DOMAIN, 'AuthRequired: huodongxing/search requires login or passed verification');
    }

    if (!items.length) {
      throw new EmptyResultError('huodongxing/search', 'No event records found (blocked page or selector mismatch)');
    }

    for (const row of items) {
      if (!row.url) continue;
      try {
        const detail = await enrichHuodongxingDetail(page, row.url);
        const detailTitle = typeof detail.title === 'string' ? detail.title : null;
        const detailAuthor = typeof detail.author === 'string' ? detail.author : null;
        const detailPublishedAt = typeof detail.published_at === 'string' ? detail.published_at : null;
        const detailRawId = detail.raw_id == null ? null : String(detail.raw_id);
        const detailEventTime = typeof detail.event_time === 'string' ? detail.event_time : null;
        const detailLocation = typeof detail.location === 'string' ? detail.location : null;
        const detailFee = typeof detail.fee === 'string' ? detail.fee : null;
        const detailOrganizer = typeof detail.organizer === 'string' ? detail.organizer : null;
        const detailSignupCount = readNumber(detail.signupCount);

        if ((!row.title || looksLikeNoiseText(row.title)) && detailTitle) row.title = detailTitle;
        if ((!row.author || looksLikeNoiseText(row.author)) && detailAuthor) row.author = detailAuthor;
        if (!row.published_at && detailPublishedAt) row.published_at = detailPublishedAt;
        if (!row.raw_id && detailRawId) row.raw_id = detailRawId;
        if (detailEventTime) row.event_time = detailEventTime;
        if (detailLocation) row.location = detailLocation;
        if (detailFee) row.fee = detailFee;
        if (detailOrganizer) row.organizer = detailOrganizer;

        if (detailSignupCount != null) {
          row.engagement = {
            ...row.engagement,
            signupCount: detailSignupCount,
          };
        }
      } catch {
        // Detail enrichment is best-effort; keep base row.
      }
    }

    return items;
  },
});

export const __test__ = {
  MAX_LIMIT,
  normalizeLimit,
  resolveSearchUrl,
  toAbsoluteUrl,
};
