import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { CliCommand } from '@jackwener/opencli/registry';
import { getRegistry } from '@jackwener/opencli/registry';
import type { IPage } from '@jackwener/opencli/types';
import './search.js';

function createPage(result: unknown): IPage {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(result),
    autoScroll: vi.fn().mockResolvedValue(undefined),
  } as unknown as IPage;
}

let cmd: CliCommand;

beforeAll(() => {
  cmd = getRegistry().get('huodongxing/search')!;
  expect(cmd?.func).toBeTypeOf('function');
});

describe('huodongxing/search', () => {
  it('returns event records with signup engagement', async () => {
    const page = createPage({
      authRequired: false,
      items: [
        {
          title: 'AI Meetup',
          url: '/event/123456789',
          author: 'Shanghai AI Club',
          published_at: '2026-04-08T19:00:00+08:00',
          raw_id: '123456789',
          engagement: { signupCount: 256 },
        },
      ],
    });

    const rows = await cmd.func!(page, { query_or_url: 'AI', limit: 20 }) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: 'AI Meetup',
      url: 'https://www.huodongxing.com/event/123456789',
      author: 'Shanghai AI Club',
      published_at: '2026-04-08T19:00:00+08:00',
      raw_id: '123456789',
      engagement: { signupCount: 256 },
    });
  });

  it('throws AuthRequiredError on auth/risk signal', async () => {
    const page = createPage({ authRequired: true, items: [] });
    await expect(cmd.func!(page, { query_or_url: '', limit: 20 })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });
});
