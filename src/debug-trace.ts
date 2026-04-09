import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

type TracePayload = Record<string, unknown>;

function isVerbose(): boolean {
  return !!process.env.OPENCLI_VERBOSE || !!process.env.DEBUG?.includes('opencli');
}

function getTraceFilePath(): string | null {
  const file = process.env.OPENCLI_DEBUG_LOG_FILE?.trim();
  return file ? file : null;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

export function traceDebug(scope: string, event: string, payload: TracePayload = {}): void {
  const record = {
    ts: new Date().toISOString(),
    scope,
    event,
    ...payload,
  };

  if (isVerbose()) {
    process.stderr.write('[' + scope + '] ' + event + ' ' + safeJson(payload) + '\n');
  }

  const filePath = getTraceFilePath();
  if (!filePath) return;

  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
  } catch {
    // Debug tracing must never break the crawl path.
  }
}
