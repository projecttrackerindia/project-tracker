import { describe, expect, it } from 'vitest';
import { idOfPath, isQueueable, patchById } from './outbox';

const id = '0b6f3c1e-1111-4222-8333-944455556666';
describe('outbox', () => {
  it('queues only small edits to key data', () => {
    expect(isQueueable('PUT', `/tasks/${id}`)).toBe(true);
    expect(isQueueable('PATCH', `/notes/${id}`)).toBe(true);
    expect(isQueueable('POST', `/reminders/${id}/done`)).toBe(true);
    expect(isQueueable('GET', `/tasks/${id}`)).toBe(false);
    expect(isQueueable('POST', '/auth/login')).toBe(false);
    expect(isQueueable('PUT', '/reminders/settings')).toBe(false);
    expect(isQueueable('DELETE', `/projects/${id}`)).toBe(false);
  });
  it('patches every cached copy of the item and returns it', () => {
    const data = { items: [{ id, title: 'Old', status: 'Todo' }, { id: 'x', title: 'Other' }] };
    const r = patchById(data, id, { title: 'New' });
    expect(r.hit).toEqual({ id, title: 'New', status: 'Todo' });
    expect(r.data.items[1]).toBe(data.items[1]);
    expect(idOfPath(`/tasks/${id}/move`)).toBe(id);
  });
});
