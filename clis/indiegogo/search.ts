import { AuthRequiredError, EmptyResultError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';

const DOMAIN = 'www.indiegogo.com';
const BASE_URL = 'https://www.indiegogo.com';
const DEFAULT_SEARCH_URL = BASE_URL + '/projects/search?sort=trending';
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
  return BASE_URL + '/projects/search?q=' + encodeURIComponent(raw) + '&sort=trending';
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
  site: 'indiegogo',
  name: 'search',
  description: 'Search Indiegogo campaigns (JSON-friendly fields for integrations)',
  domain: DOMAIN,
  strategy: Strategy.COOKIE,
  args: [
    { name: 'query_or_url', positional: true, required: false, help: 'Search keyword or full Indiegogo search URL' },
    { name: 'limit', type: 'int', default: 20, help: 'Number of results to return' },
  ],
  columns: ['title', 'author', 'backers', 'published_at', 'url', 'raw_id'],
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

        var cards = document.querySelectorAll('a[href*="/projects/"]');
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
          var author = firstText(card, ['[class*="owner"]', '[class*="creator"]', '[class*="byline"]']);
          var publishedAt = firstAttr(card, ['time'], 'datetime') || firstText(card, ['time']);
          var backersText = firstText(card, ['[class*="backer"]', '[class*="supporter"]']);
          var backerMatch = backersText.match(/\\d+[\\d,]*/);
          var backers = backerMatch ? Number(backerMatch[0].replace(/,/g, '')) : null;
          var rawMatch = url.match(/\\/projects\\/([^/?#]+)/);
          var rawId = rawMatch ? clean(rawMatch[1]) : '';

          if (!title && !url) continue;

          items.push({
            title: title || null,
            url: url || null,
            author: author || null,
            published_at: publishedAt || null,
            raw_id: rawId || null,
            engagement: backers != null ? { backers: backers } : {},
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

    // Avoid false positives: some normal pages include "sign in" copy even when
    // results are visible. Only treat as auth-required when no usable items exist.
    if (payload?.authRequired && items.length === 0) {
      throw new AuthRequiredError(DOMAIN, 'AuthRequired: indiegogo/search requires login or passed verification');
    }

    if (!items.length) {
      throw new EmptyResultError('indiegogo/search', 'No campaign records found (blocked page or selector mismatch)');
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
