/** Quiet hours, DND and snooze may defer OS delivery while the in-app item is already visible. */
export function deliveryTime(n: { createdAt: string; deliverAfter?: string | null }): number {
  const created = Date.parse(n.createdAt);
  return n.deliverAfter ? Math.max(created, Date.parse(n.deliverAfter)) : created;
}
