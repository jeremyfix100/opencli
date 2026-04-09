import { createHash } from 'node:crypto';

export type DomLearningField =
  | 'title'
  | 'organizer'
  | 'event_time'
  | 'location'
  | 'fee'
  | 'signup_text';

export type DomLearningCandidate = {
  selector: string;
  text: string;
  tag: string;
  href?: string | null;
  datetime?: string | null;
  title?: string | null;
  ariaLabel?: string | null;
};

export type DistilledDomLearningCandidates = {
  summary: {
    totalCandidates: number;
    keptCandidates: number;
  };
  fieldHints: Record<DomLearningField, string[]>;
  promptCandidates: Array<{
    selector: string;
    text: string;
    tag: string;
    href?: string | null;
    datetime?: string | null;
  }>;
};

export type DomLearningSnapshot = {
  url: string;
  title: string;
  candidates: DomLearningCandidate[];
};

const FIELD_KEYWORDS: Record<DomLearningField, string[]> = {
  title: ['title', 'details-title', 'event-name', 'activity-title', 'headline', '主题', '标题'],
  organizer: ['organizer', 'host', '主办方', '举办方', '组织方', '发起人'],
  event_time: ['time', 'date', 'datetime', 'event-time', '活动时间', '时间', '日期'],
  location: ['location', 'address', 'venue', 'place', '地点', '地址', '场地'],
  fee: ['fee', 'price', 'ticket', 'cost', 'free', '费用', '票价', '免费'],
  signup_text: ['signup', '报名', 'register', 'registration', '已报名', '人报名', '参加'],
};

const NOISE_KEYWORDS = [
  '首页',
  '行业',
  '生活',
  '学习',
  '找活动',
  '专题',
  '人气榜',
  '下载app',
  '精选推荐',
  '登录',
  '注册',
  'cookie',
  '隐私',
  '版权',
  '广告',
];

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isNoiseCandidate(candidate: DomLearningCandidate): boolean {
  const haystack = `${candidate.selector} ${candidate.text} ${candidate.title ?? ''} ${candidate.ariaLabel ?? ''}`.toLowerCase();
  if (NOISE_KEYWORDS.some((keyword) => haystack.includes(keyword.toLowerCase()))) {
    return true;
  }
  const text = candidate.text.trim();
  if (!text) return true;
  if (text.length > 120) return true;
  if (text.length < 2) return true;
  return false;
}

function baseScore(candidate: DomLearningCandidate): number {
  const tag = candidate.tag.toLowerCase();
  let score = 0;
  if (tag === 'h1') score += 40;
  else if (tag === 'h2') score += 34;
  else if (tag === 'h3') score += 30;
  else if (tag === 'time') score += 32;
  else if (tag === 'a') score += 20;
  else if (tag === 'strong' || tag === 'b') score += 14;
  else score += 8;

  const selectorText = `${candidate.selector} ${candidate.text} ${candidate.title ?? ''} ${candidate.ariaLabel ?? ''}`.toLowerCase();
  for (const field of Object.keys(FIELD_KEYWORDS) as DomLearningField[]) {
    for (const keyword of FIELD_KEYWORDS[field]) {
      if (selectorText.includes(keyword.toLowerCase())) {
        score += field === 'title' ? 22 : 16;
        break;
      }
    }
  }

  if (candidate.datetime) score += 15;
  if (candidate.href) score += 8;
  if (candidate.text.length <= 24) score += 4;
  return score;
}

function fieldScore(candidate: DomLearningCandidate, field: DomLearningField): number {
  const selectorText = `${candidate.selector} ${candidate.text} ${candidate.title ?? ''} ${candidate.ariaLabel ?? ''}`.toLowerCase();
  let score = 0;
  for (const keyword of FIELD_KEYWORDS[field]) {
    if (selectorText.includes(keyword.toLowerCase())) {
      score += 25;
    }
  }
  if (field === 'event_time' && candidate.datetime) score += 30;
  if (field === 'title' && /^h[1-3]$/.test(candidate.tag.toLowerCase())) score += 20;
  return score + baseScore(candidate);
}

function toPromptCandidate(candidate: DomLearningCandidate): {
  selector: string;
  text: string;
  tag: string;
  href?: string | null;
  datetime?: string | null;
} {
  return {
    selector: candidate.selector,
    text: candidate.text,
    tag: candidate.tag,
    href: candidate.href ?? undefined,
    datetime: candidate.datetime ?? undefined,
  };
}

function normalizePath(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => {
      if (!segment) return segment;
      if (/^\d+$/.test(segment)) return ':id';
      if (/^[0-9a-f]{8,}$/i.test(segment)) return ':token';
      return segment.replace(/\d+/g, ':n');
    })
    .join('/');
}

export function buildDomFingerprint(input: { url: string; candidates: DomLearningCandidate[] }): string {
  let normalizedUrl = input.url;
  try {
    const parsed = new URL(input.url);
    normalizedUrl = `${parsed.protocol}//${parsed.host}${normalizePath(parsed.pathname)}`;
  } catch {
    normalizedUrl = input.url;
  }

  const selectorSignature = Array.from(new Set(input.candidates.map((candidate) => candidate.selector).filter(Boolean)))
    .sort()
    .slice(0, 20)
    .join('|');
  return createHash('sha1').update(`${normalizedUrl}::${selectorSignature}`).digest('hex');
}

export function distillDomLearningCandidates(
  candidates: DomLearningCandidate[],
  options?: { maxCandidates?: number; maxPerField?: number },
): DistilledDomLearningCandidates {
  const maxCandidates = Math.max(1, options?.maxCandidates ?? 80);
  const maxPerField = Math.max(1, options?.maxPerField ?? 6);
  const filtered = candidates
    .map((candidate) => ({
      ...candidate,
      text: normalizeWhitespace(candidate.text),
      title: candidate.title ? normalizeWhitespace(candidate.title) : candidate.title,
      ariaLabel: candidate.ariaLabel ? normalizeWhitespace(candidate.ariaLabel) : candidate.ariaLabel,
    }))
    .filter((candidate) => !isNoiseCandidate(candidate));

  const ranked = filtered
    .map((candidate) => ({
      candidate,
      score: baseScore(candidate),
    }))
    .sort((a, b) => b.score - a.score);

  const keptCandidates = ranked.slice(0, maxCandidates).map((entry) => toPromptCandidate(entry.candidate));
  const fieldHints = {} as Record<DomLearningField, string[]>;
  for (const field of Object.keys(FIELD_KEYWORDS) as DomLearningField[]) {
    fieldHints[field] = filtered
      .map((candidate) => ({
        candidate,
        score: fieldScore(candidate, field),
      }))
      .sort((a, b) => b.score - a.score)
      .filter((entry) => entry.score > 0)
      .slice(0, maxPerField)
      .map((entry) => entry.candidate.selector);
  }

  return {
    summary: {
      totalCandidates: candidates.length,
      keptCandidates: keptCandidates.length,
    },
    fieldHints,
    promptCandidates: keptCandidates,
  };
}

export async function collectDomLearningSnapshot(page: {
  evaluate: (js: string) => Promise<unknown>;
}): Promise<DomLearningSnapshot> {
  const snapshot = await page.evaluate(`
    (function () {
      function clean(v) {
        return String(v || '').replace(/\\s+/g, ' ').trim();
      }
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
      var selector = 'h1,h2,h3,h4,h5,h6,p,li,div,span,time,a,strong,b';
      var nodes = document.querySelectorAll(selector);
      var out = [];
      for (var i = 0; i < nodes.length && out.length < 250; i++) {
        var el = nodes[i];
        if (!el || !el.textContent) continue;
        var text = clean(el.textContent);
        if (!text || text.length < 2 || text.length > 120) continue;
        if (el.tagName && el.tagName.toLowerCase() !== 'a') {
          var rects = el.getClientRects ? el.getClientRects() : null;
          if (rects && rects.length === 0) continue;
        }
        out.push({
          selector: cssPath(el),
          text: text,
          tag: (el.tagName || '').toLowerCase(),
          href: el.getAttribute ? (el.getAttribute('href') || '') : '',
          datetime: el.getAttribute ? (el.getAttribute('datetime') || '') : '',
          title: el.getAttribute ? (el.getAttribute('title') || '') : '',
          ariaLabel: el.getAttribute ? (el.getAttribute('aria-label') || '') : '',
        });
      }
      return {
        url: location.href || '',
        title: document.title || '',
        candidates: out,
      };
    })()
  `);

  if (!snapshot || typeof snapshot !== 'object') {
    return { url: '', title: '', candidates: [] };
  }

  const record = snapshot as Record<string, unknown>;
  const candidates = Array.isArray(record.candidates)
    ? record.candidates
        .map((item) => item as Record<string, unknown>)
        .filter((item) => typeof item.selector === 'string' && typeof item.text === 'string' && typeof item.tag === 'string')
        .map((item) => ({
          selector: String(item.selector),
          text: String(item.text),
          tag: String(item.tag),
          href: typeof item.href === 'string' ? item.href : null,
          datetime: typeof item.datetime === 'string' ? item.datetime : null,
          title: typeof item.title === 'string' ? item.title : null,
          ariaLabel: typeof item.ariaLabel === 'string' ? item.ariaLabel : null,
        }))
    : [];

  return {
    url: typeof record.url === 'string' ? record.url : '',
    title: typeof record.title === 'string' ? record.title : '',
    candidates,
  };
}
