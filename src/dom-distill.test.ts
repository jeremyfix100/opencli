import { describe, expect, it } from 'vitest';
import { buildDomFingerprint, distillDomLearningCandidates } from './dom-distill.js';

describe('dom-distill', () => {
  it('prioritizes event detail candidates and removes navigation noise', () => {
    const result = distillDomLearningCandidates([
      { selector: 'header nav a', text: '首页', tag: 'a' },
      { selector: 'header nav a', text: '行业', tag: 'a' },
      { selector: '.hdx-details-title', text: '链动春耕 新启全球', tag: 'h1' },
      { selector: '.hdx-organizer', text: '亚马逊全球开店', tag: 'div' },
      { selector: '.hdx-event-time', text: '2026-04-20 14:00-17:00', tag: 'div' },
      { selector: '.hdx-address', text: '厦门思明区', tag: 'div' },
      { selector: '.hdx-fee', text: '免费', tag: 'div' },
      { selector: '.signup', text: '923人报名', tag: 'div' },
    ]);

    expect(result.summary.totalCandidates).toBe(8);
    expect(result.summary.keptCandidates).toBeLessThan(8);
    expect(result.fieldHints.title).toContain('.hdx-details-title');
    expect(result.fieldHints.organizer).toContain('.hdx-organizer');
    expect(result.fieldHints.event_time).toContain('.hdx-event-time');
    expect(result.fieldHints.location).toContain('.hdx-address');
    expect(result.fieldHints.fee).toContain('.hdx-fee');
    expect(result.fieldHints.signup_text).toContain('.signup');
  });

  it('builds a stable fingerprint from url shape and candidate selectors', () => {
    const a = buildDomFingerprint({
      url: 'https://www.huodongxing.com/event/5846805200111?utm_source=x',
      candidates: [{ selector: '.hdx-details-title', text: 'A', tag: 'h1' }],
    });
    const b = buildDomFingerprint({
      url: 'https://www.huodongxing.com/event/9999999999999?utm_source=y',
      candidates: [{ selector: '.hdx-details-title', text: 'B', tag: 'h1' }],
    });

    expect(a).toBe(b);
  });
});
