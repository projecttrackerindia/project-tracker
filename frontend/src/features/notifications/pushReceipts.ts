/** A server subscription is not delivery. Only a worker's successful display acknowledges a push here. */
const receipts = new Map<string, number>();
const RETAIN_MS = 120_000;
const MAX_RECEIPTS = 256;

export function recordPushReceipt(tag: string, now = Date.now()) {
  if (!tag) return;
  for (const [id, at] of receipts) if (now - at >= RETAIN_MS) receipts.delete(id);
  receipts.delete(tag);
  receipts.set(tag, now);
  while (receipts.size > MAX_RECEIPTS) receipts.delete(receipts.keys().next().value!);
}

export function hasPushReceipt(tag: string, now = Date.now()): boolean {
  const at = receipts.get(tag);
  return at !== undefined && now >= at && now - at < RETAIN_MS;
}

export async function waitForPushReceipt(tag: string, delayMs = 1500): Promise<boolean> {
  if (hasPushReceipt(tag)) return true;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  return hasPushReceipt(tag);
}
