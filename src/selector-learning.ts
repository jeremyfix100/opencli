import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { learnSelectorPlan as learnSelectorPlanCore, parseSelectorPlan, type SelectorPlan } from 'mkt-learning-engine';
import { log } from '@jackwener/opencli/logger';
import { traceDebug } from './debug-trace.js';
import { distillDomLearningCandidates, type DomLearningField, type DomLearningSnapshot } from './dom-distill.js';

export type LearnedSelectorSet = Record<DomLearningField, string[]>;
export type LearnedSelectorFieldPlan = {
  selectors: string[];
  fallback_selectors: string[];
  confidence: number;
  reason: string;
};
export type LearnedSelectorPlan = Record<DomLearningField, LearnedSelectorFieldPlan>;
type RawLearnedFieldPlan = {
  selectors?: unknown;
  fallback_selectors?: unknown;
  confidence?: unknown;
  reason?: unknown;
};

export type SelectorLearningCache = {
  version: 2;
  entries: Record<string, LearnedSelectorSet>;
  plans?: Record<string, LearnedSelectorPlan>;
};

type LlmChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

function getCacheFilePath(): string {
  return process.env.OPENCLI_SELECTOR_CACHE_PATH ?? path.join(os.homedir(), '.opencli', 'selector-learning-cache.json');
}

function emptySelectorSet(): LearnedSelectorSet {
  return {
    title: [],
    organizer: [],
    event_time: [],
    location: [],
    fee: [],
    signup_text: [],
  };
}

function emptySelectorPlan(): LearnedSelectorPlan {
  return {
    title: { selectors: [], fallback_selectors: [], confidence: 0, reason: '' },
    organizer: { selectors: [], fallback_selectors: [], confidence: 0, reason: '' },
    event_time: { selectors: [], fallback_selectors: [], confidence: 0, reason: '' },
    location: { selectors: [], fallback_selectors: [], confidence: 0, reason: '' },
    fee: { selectors: [], fallback_selectors: [], confidence: 0, reason: '' },
    signup_text: { selectors: [], fallback_selectors: [], confidence: 0, reason: '' },
  };
}

function toEngineSelectorPlan(plan: LearnedSelectorPlan): SelectorPlan {
  return {
    plans: Object.entries(plan).map(([field, fieldPlan]) => ({
      field: field as DomLearningField,
      selectors: fieldPlan.selectors,
      fallback_selectors: fieldPlan.fallback_selectors,
      confidence: fieldPlan.confidence,
      reason: fieldPlan.reason,
    })),
  };
}

function toLearnedSelectorPlan(plan: SelectorPlan): LearnedSelectorPlan {
  const learned = emptySelectorPlan();
  for (const entry of plan.plans) {
    learned[entry.field as DomLearningField] = {
      selectors: entry.selectors,
      fallback_selectors: entry.fallback_selectors,
      confidence: entry.confidence,
      reason: entry.reason,
    };
  }
  return learned;
}

function toLearnedSelectorSet(plan: LearnedSelectorPlan): LearnedSelectorSet {
  return {
    title: plan.title.selectors,
    organizer: plan.organizer.selectors,
    event_time: plan.event_time.selectors,
    location: plan.location.selectors,
    fee: plan.fee.selectors,
    signup_text: plan.signup_text.selectors,
  };
}

function normalizeSelectorArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const selectors: string[] = [];
  for (const item of value) {
    const selector = String(item ?? '').trim();
    if (!selector || seen.has(selector)) continue;
    seen.add(selector);
    selectors.push(selector);
  }
  return selectors.slice(0, 8);
}

function normalizeFieldPlanSelectors(value: unknown): string[] {
  if (Array.isArray(value)) {
    return normalizeSelectorArray(value);
  }
  if (value && typeof value === 'object') {
    const plan = value as RawLearnedFieldPlan;
    return normalizeSelectorArray(plan.selectors);
  }
  return [];
}

function parseFieldPlan(value: unknown): LearnedSelectorFieldPlan {
  if (Array.isArray(value)) {
    return {
      selectors: normalizeSelectorArray(value),
      fallback_selectors: [],
      confidence: 0,
      reason: '',
    };
  }
  if (value && typeof value === 'object') {
    const plan = value as RawLearnedFieldPlan;
    return {
      selectors: normalizeSelectorArray(plan.selectors),
      fallback_selectors: normalizeSelectorArray(plan.fallback_selectors),
      confidence: typeof plan.confidence === 'number' && Number.isFinite(plan.confidence) ? plan.confidence : 0,
      reason: typeof plan.reason === 'string' ? plan.reason.trim() : '',
    };
  }
  return {
    selectors: [],
    fallback_selectors: [],
    confidence: 0,
    reason: '',
  };
}

function parseLearnedSelectorPlanRecord(raw: unknown): LearnedSelectorPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const learned: LearnedSelectorPlan = {
    title: parseFieldPlan(record.title),
    organizer: parseFieldPlan(record.organizer),
    event_time: parseFieldPlan(record.event_time),
    location: parseFieldPlan(record.location),
    fee: parseFieldPlan(record.fee),
    signup_text: parseFieldPlan(record.signup_text),
  };

  return Object.values(learned).some((item) => item.selectors.length > 0 || item.fallback_selectors.length > 0) ? learned : null;
}

export function parseLearnedSelectorPlan(raw: unknown): LearnedSelectorPlan | null {
  try {
    const parsed = parseSelectorPlan(JSON.stringify(raw));
    return toLearnedSelectorPlan(parsed);
  } catch {
    return parseLearnedSelectorPlanRecord(raw);
  }
}

export function parseLearnedSelectorSet(raw: unknown): LearnedSelectorSet | null {
  const plan = parseLearnedSelectorPlan(raw);
  if (!plan) return null;
  return toLearnedSelectorSet(plan);
}

export async function readSelectorLearningCache(): Promise<SelectorLearningCache | null> {
  try {
    const raw = await readFile(getCacheFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as SelectorLearningCache;
    if (!parsed || typeof parsed.entries !== 'object' || parsed.entries === null) {
      return null;
    }
    if (parsed.version === 2) {
      return parsed;
    }
    if ((parsed as { version?: number }).version === 1) {
      return {
        version: 2,
        entries: parsed.entries,
        plans: Object.fromEntries(
          Object.entries(parsed.entries).map(([fingerprint, selectors]) => [
            fingerprint,
            {
              ...emptySelectorPlan(),
              title: { ...emptySelectorPlan().title, selectors: selectors.title ?? [] },
              organizer: { ...emptySelectorPlan().organizer, selectors: selectors.organizer ?? [] },
              event_time: { ...emptySelectorPlan().event_time, selectors: selectors.event_time ?? [] },
              location: { ...emptySelectorPlan().location, selectors: selectors.location ?? [] },
              fee: { ...emptySelectorPlan().fee, selectors: selectors.fee ?? [] },
              signup_text: { ...emptySelectorPlan().signup_text, selectors: selectors.signup_text ?? [] },
            },
          ]),
        ),
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function writeSelectorLearningCache(cache: SelectorLearningCache): Promise<void> {
  const filePath = getCacheFilePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf-8');
}

async function getCachedSelectors(fingerprint: string): Promise<LearnedSelectorSet | null> {
  const cache = await readSelectorLearningCache();
  return cache?.entries[fingerprint] ?? null;
}

async function getCachedSelectorPlan(fingerprint: string): Promise<LearnedSelectorPlan | null> {
  const cache = await readSelectorLearningCache();
  return cache?.plans?.[fingerprint] ?? null;
}

async function writeEngineSelectorPlanCache(cache: Record<string, SelectorPlan>): Promise<void> {
  const nextCache: SelectorLearningCache = {
    version: 2,
    entries: {},
  };
  const plans: Record<string, LearnedSelectorPlan> = {};

  for (const [fingerprint, plan] of Object.entries(cache)) {
    const learnedPlan = toLearnedSelectorPlan(plan);
    nextCache.entries[fingerprint] = toLearnedSelectorSet(learnedPlan);
    plans[fingerprint] = learnedPlan;
  }

  nextCache.plans = plans;

  await writeSelectorLearningCache(nextCache);
}

function canUseLlmLearning(): boolean {
  return Boolean(
    process.env.MKT_CRAWLER_LLM_ENDPOINT &&
      process.env.MKT_CRAWLER_LLM_API_KEY &&
      process.env.MKT_CRAWLER_LLM_MODEL,
  );
}

export async function learnSelectorsFromSnapshot(input: {
  site: string;
  fingerprint: string;
  snapshot: DomLearningSnapshot;
}): Promise<LearnedSelectorSet | null> {
  const plan = await learnSelectorPlanFromSnapshot(input);
  if (!plan) return null;
  return toLearnedSelectorSet(plan);
}

export async function learnSelectorPlanFromSnapshot(input: {
  site: string;
  fingerprint: string;
  snapshot: DomLearningSnapshot;
}): Promise<LearnedSelectorPlan | null> {
  const cachedPlan = await getCachedSelectorPlan(input.fingerprint);
  if (cachedPlan) {
    log.debug(
      `[selector-learning] cache hit site=${input.site} fingerprint=${input.fingerprint.slice(0, 8)} fields=${Object.entries(cachedPlan)
        .filter(([, fieldPlan]) => fieldPlan.selectors.length > 0)
        .map(([field]) => field)
        .join(',') || 'none'}`,
    );
    traceDebug('selector-learning', 'cache-hit', {
      site: input.site,
      fingerprint: input.fingerprint.slice(0, 8),
      cacheHit: true,
      fields: Object.entries(cachedPlan)
        .filter(([, fieldPlan]) => fieldPlan.selectors.length > 0)
        .map(([field]) => field),
    });
    return cachedPlan;
  }

  const cached = await getCachedSelectors(input.fingerprint);
  if (cached) {
    const learnedPlan = parseLearnedSelectorPlanRecord({
      title: { selectors: cached.title },
      organizer: { selectors: cached.organizer },
      event_time: { selectors: cached.event_time },
      location: { selectors: cached.location },
      fee: { selectors: cached.fee },
      signup_text: { selectors: cached.signup_text },
    });
    if (!learnedPlan) {
      return null;
    }
    log.debug(
      `[selector-learning] cache hit site=${input.site} fingerprint=${input.fingerprint.slice(0, 8)} fields=${Object.entries(cached)
        .filter(([, selectors]) => selectors.length > 0)
        .map(([field]) => field)
        .join(',') || 'none'}`,
    );
    traceDebug('selector-learning', 'cache-hit', {
      site: input.site,
      fingerprint: input.fingerprint.slice(0, 8),
      cacheHit: true,
      fields: Object.entries(cached)
        .filter(([, selectors]) => selectors.length > 0)
        .map(([field]) => field),
    });
    return learnedPlan;
  }

  if (!canUseLlmLearning()) {
    log.debug(`[selector-learning] LLM disabled site=${input.site} fingerprint=${input.fingerprint.slice(0, 8)}`);
    traceDebug('selector-learning', 'llm-disabled', {
      site: input.site,
      fingerprint: input.fingerprint.slice(0, 8),
    });
    return null;
  }

  const distilled = distillDomLearningCandidates(input.snapshot.candidates, {
    maxCandidates: 60,
    maxPerField: 8,
  });
  traceDebug('selector-learning', 'learn-start', {
    site: input.site,
    fingerprint: input.fingerprint.slice(0, 8),
    url: input.snapshot.url,
    totalCandidates: distilled.summary.totalCandidates,
    keptCandidates: distilled.summary.keptCandidates,
  });
  log.info(
    `[selector-learning] learn site=${input.site} fingerprint=${input.fingerprint.slice(0, 8)} candidates=${distilled.summary.totalCandidates} kept=${distilled.summary.keptCandidates}`,
  );
  log.debug(
    `[selector-learning] field hints site=${input.site} ${Object.entries(distilled.fieldHints)
      .map(([field, selectors]) => `${field}=${selectors.slice(0, 3).join('|') || '-'}`)
      .join(' ')}`,
  );
  traceDebug('selector-learning', 'field-hints', {
    site: input.site,
    fingerprint: input.fingerprint.slice(0, 8),
    hints: Object.fromEntries(Object.entries(distilled.fieldHints).map(([field, selectors]) => [field, selectors.slice(0, 3)])),
  });

  try {
    const enginePlan = await learnSelectorPlanCore(
      { fingerprint: input.fingerprint },
      {
        cache: {
          read: async () => null,
          write: writeEngineSelectorPlanCache,
        },
        requestLlm: async () => {
          const endpoint = process.env.MKT_CRAWLER_LLM_ENDPOINT as string;
          traceDebug('selector-learning', 'llm-request', {
            site: input.site,
            fingerprint: input.fingerprint.slice(0, 8),
            endpoint,
            model: process.env.MKT_CRAWLER_LLM_MODEL ?? '',
            candidateCount: distilled.promptCandidates.length,
          });

          const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${process.env.MKT_CRAWLER_LLM_API_KEY}`,
            },
            body: JSON.stringify({
              model: process.env.MKT_CRAWLER_LLM_MODEL,
              temperature: 0,
              messages: [
                {
                  role: 'system',
                  content:
                    'You are a DOM extraction planner for event pages. Return strict JSON only with arrays of CSS selectors for each field.',
                },
                {
                  role: 'user',
                  content: JSON.stringify({
                    site: input.site,
                    url: input.snapshot.url,
                    title: input.snapshot.title,
                    field_hints: distilled.fieldHints,
                    candidates: distilled.promptCandidates,
                    output_schema: {
                      title: [],
                      organizer: [],
                      event_time: [],
                      location: [],
                      fee: [],
                      signup_text: [],
                    },
                  }),
                },
              ],
            }),
          });

          if (!response.ok) {
            log.warn(
              `[selector-learning] LLM request failed site=${input.site} fingerprint=${input.fingerprint.slice(0, 8)} status=${response.status}`,
            );
            traceDebug('selector-learning', 'llm-response-failed', {
              site: input.site,
              fingerprint: input.fingerprint.slice(0, 8),
              status: response.status,
            });
            return null;
          }

          const payload = (await response.json()) as LlmChatCompletionResponse;
          const content = payload.choices?.[0]?.message?.content ?? '';
          if (!content) {
            log.warn(`[selector-learning] empty LLM response site=${input.site} fingerprint=${input.fingerprint.slice(0, 8)}`);
            traceDebug('selector-learning', 'llm-empty-response', {
              site: input.site,
              fingerprint: input.fingerprint.slice(0, 8),
            });
            return null;
          }

          return content;
        },
        trace: async (event) => {
          if (event.event === 'llm-response') {
            traceDebug('selector-learning', 'llm-response', {
              site: input.site,
              fingerprint: input.fingerprint.slice(0, 8),
              rawResponse: event.rawResponse,
            });
          }
          if (event.event === 'cache-write') {
            traceDebug('selector-learning', 'cache-write', {
              site: input.site,
              fingerprint: input.fingerprint.slice(0, 8),
              cacheHit: false,
            });
          }
        },
      },
    );
    if (!enginePlan) {
      return null;
    }
    const learnedPlan = toLearnedSelectorPlan(enginePlan);

    log.debug(
      `[selector-learning] cached selectors site=${input.site} fingerprint=${input.fingerprint.slice(0, 8)} fields=${Object.entries(learnedPlan)
        .filter(([, fieldPlan]) => fieldPlan.selectors.length > 0)
        .map(([field]) => field)
        .join(',') || 'none'}`,
    );
    traceDebug('selector-learning', 'cache-write', {
      site: input.site,
      fingerprint: input.fingerprint.slice(0, 8),
      cacheHit: false,
      fields: Object.entries(learnedPlan)
        .filter(([, fieldPlan]) => fieldPlan.selectors.length > 0)
        .map(([field]) => field),
    });
    return learnedPlan;
  } catch {
    log.warn(`[selector-learning] failed to parse selector JSON site=${input.site} fingerprint=${input.fingerprint.slice(0, 8)}`);
    traceDebug('selector-learning', 'llm-parse-error', {
      site: input.site,
      fingerprint: input.fingerprint.slice(0, 8),
    });
    return null;
  }
}

export function defaultSelectorSet(): LearnedSelectorSet {
  return emptySelectorSet();
}
