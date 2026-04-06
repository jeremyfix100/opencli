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
  columns: ['title', 'author', 'signupCount', 'published_at', 'url', 'raw_id'],
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
      }))
      .filter((item) => Boolean(item.title || item.url));

    if (payload?.authRequired && items.length === 0) {
      throw new AuthRequiredError(DOMAIN, 'AuthRequired: huodongxing/search requires login or passed verification');
    }

    if (!items.length) {
      throw new EmptyResultError('huodongxing/search', 'No event records found (blocked page or selector mismatch)');
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
