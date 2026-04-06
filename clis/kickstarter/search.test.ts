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
  cmd = getRegistry().get('kickstarter/search')!;
  expect(cmd?.func).toBeTypeOf('function');
});

describe('kickstarter/search', () => {
  it('returns shared subset fields with site-specific engagement', async () => {
    const page = createPage({
      authRequired: false,
      items: [
        {
          title: 'KS Project',
          url: '/projects/demo/ks-project',
          author: 'KS Team',
          published_at: '2026-03-30',
          raw_id: 'demo/ks-project',
          engagement: { backers: 88 },
        },
      ],
    });

    const rows = await cmd.func!(page, { query_or_url: 'AI', limit: 20 }) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: 'KS Project',
      url: 'https://www.kickstarter.com/projects/demo/ks-project',
      author: 'KS Team',
      published_at: '2026-03-30',
      raw_id: 'demo/ks-project',
      engagement: { backers: 88 },
    });
  });

  it('throws EmptyResultError when parser returns empty', async () => {
    const page = createPage({ authRequired: false, items: [] });
    await expect(cmd.func!(page, { query_or_url: 'none', limit: 20 })).rejects.toMatchObject({
      code: 'EMPTY_RESULT',
    });
  });
});
