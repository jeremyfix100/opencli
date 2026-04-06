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
  cmd = getRegistry().get('indiegogo/search')!;
  expect(cmd?.func).toBeTypeOf('function');
});

describe('indiegogo/search', () => {
  it('returns normalized records for -f json consumers', async () => {
    const page = createPage({
      authRequired: false,
      items: [
        {
          title: 'Pocket Studio',
          url: '/projects/pocket-studio',
          author: 'Acme Labs',
          published_at: '2026-04-01T00:00:00.000Z',
          raw_id: 'pocket-studio',
          engagement: { backers: 3210 },
        },
      ],
    });

    const rows = await cmd.func!(page, { query_or_url: 'https://www.indiegogo.com/projects/search?sort=trending', limit: 20 }) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: 'Pocket Studio',
      url: 'https://www.indiegogo.com/projects/pocket-studio',
      author: 'Acme Labs',
      published_at: '2026-04-01T00:00:00.000Z',
      raw_id: 'pocket-studio',
      engagement: { backers: 3210 },
    });
  });

  it('throws AuthRequiredError for login/risk pages', async () => {
    const page = createPage({ authRequired: true, items: [] });
    await expect(cmd.func!(page, { query_or_url: '', limit: 20 })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });

  it('does not raise AuthRequiredError when results are present', async () => {
    const page = createPage({
      authRequired: true,
      items: [
        {
          title: 'Visible Campaign',
          url: '/projects/visible-campaign',
          author: 'Demo Team',
          published_at: null,
          raw_id: 'visible-campaign',
          engagement: { backers: 12 },
        },
      ],
    });
    const rows = await cmd.func!(page, { query_or_url: '', limit: 20 }) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: 'Visible Campaign',
      url: 'https://www.indiegogo.com/projects/visible-campaign',
    });
  });

  it('throws EmptyResultError instead of silent empty array', async () => {
    const page = createPage({ authRequired: false, items: [] });
    await expect(cmd.func!(page, { query_or_url: '', limit: 20 })).rejects.toMatchObject({
      code: 'EMPTY_RESULT',
    });
  });
});
