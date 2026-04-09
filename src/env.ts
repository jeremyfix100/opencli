import { readFileSync } from 'node:fs';
import path from 'node:path';

type LoadProjectEnvOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  override?: boolean;
};

function parseDotEnv(content: string): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

export function loadProjectEnv(options: LoadProjectEnvOptions = {}): number {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const override = options.override ?? true;
  const filePath = path.join(cwd, '.env');

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return 0;
  }

  const parsed = parseDotEnv(content);
  let loaded = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (!override && env[key] !== undefined) continue;
    env[key] = value;
    loaded++;
  }
  return loaded;
}

export { parseDotEnv };

