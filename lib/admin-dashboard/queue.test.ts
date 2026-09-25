import { describe, expect, it } from 'vitest';
import type { Executor } from '@/lib/offers/db';
import type { OperationsQueueItemDto } from '@/lib/types/admin-dashboard';
import { compareQueueItems, priorityRank, queueLinkFor, readOperationsQueue } from './queue';

function item(overrides: Partial<OperationsQueueItemDto>): OperationsQueueItemDto {
  return {
    type: 'support_ticket',
    id: '00000000-0000-4000-8000-000000000000',
    status: 'open',
    priority: 'medium',
    createdAt: '2026-09-25T10:00:00.000Z',
    linkTo: '/x',
    ...overrides,
  };
}

describe('spec 037 Operations queue rules (unit)', () => {
  it('orders by priority then age: critical > high > medium > low > none (disputes last)', () => {
    const items = [
      item({ id: 'a', priority: null, type: 'dispute', createdAt: '2026-01-01T00:00:00.000Z' }),
      item({ id: 'b', priority: 'low' }),
      item({ id: 'c', priority: 'critical', createdAt: '2026-09-25T12:00:00.000Z' }),
      item({ id: 'd', priority: 'critical', createdAt: '2026-09-25T09:00:00.000Z' }),
      item({ id: 'e', priority: 'high' }),
      item({ id: 'f', priority: 'medium' }),
    ];
    expect([...items].sort(compareQueueItems).map((i) => i.id)).toEqual(['d', 'c', 'e', 'f', 'b', 'a']);
  });

  it('breaks an exact priority/time tie by id, so paging is stable', () => {
    const [x, y] = [item({ id: 'b1' }), item({ id: 'a9' })];
    expect([x, y].sort(compareQueueItems).map((i) => i.id)).toEqual(['a9', 'b1']);
    expect(compareQueueItems(x, x)).toBe(0);
  });

  it('ranks priorities with null lowest', () => {
    expect([priorityRank('critical'), priorityRank('high'), priorityRank('medium'), priorityRank('low'), priorityRank(null)]).toEqual([
      4, 3, 2, 1, 0,
    ]);
  });

  it('links each item to its existing workflow route', () => {
    expect(queueLinkFor('dispute', 'd1')).toBe('/admin/operations/disputes/d1');
    expect(queueLinkFor('support_ticket', 't1')).toBe('/admin/operations/support/t1');
    expect(queueLinkFor('safety_report', 's1')).toBe('/admin/operations/safety');
  });

  it('a caller who can read no source gets an empty page and no query runs', async () => {
    const untouchable = {
      execute: () => {
        throw new Error('no query expected');
      },
    } as unknown as Executor;
    expect(
      await readOperationsQueue(untouchable, { disputes: false, supportTickets: false, safetyReports: false }, { limit: 20, offset: 0 }),
    ).toEqual({ items: [], total: 0 });
  });
});
