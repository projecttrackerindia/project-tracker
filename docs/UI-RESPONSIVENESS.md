# Instant-feeling saves: how a change should travel

A change a person makes (drag a card, move a calendar entry, tick a task, save a field) must show **at once**, stay put, and then be
confirmed. It must never jump back, vanish, or wait for the network. This is how the app is built to do that, what was found to break it,
and the rules that keep it fixed.

## What was found (measured in the code, not guessed)

| Symptom | Cause | Fixed in |
|---|---|---|
| A board card moved, snapped back, moved again | The card was patched while an older read of the board was still on its way; that read carried the old column and landed on top. A second read of the whole workspace then followed. | `Board.tsx`: cancel the older reads first, patch, then put the server's own answer in the cache. No workspace-wide refresh. |
| A calendar entry vanished after an edit | Every edit was shown from a small local layer that was **emptied whenever any timeline read landed**, including a read that started before the save finished. | `useDayEdit.ts`: an edit stays until the server's answer shows it (or 20 s pass). |
| "Everything is slow" after a save | 50 places refresh **every open view of the workspace** after one change (`invalidateWorkspace(wid)`), 452 hand-written refreshes in all, on top of the shared refresh that already runs after each write. One card move caused a dozen unrelated reads. | A ceiling test (`lib/coarseRefresh.test.ts`) so this can only go down; the worst call on the board is gone. |
| Nobody could tell server time from network time | No timing on the server. | `MetricsMiddleware`: a `Server-Timing` header on every API answer and a warning for any request over 800 ms. |

Still open, and **needs the timing above to prove**: a task move runs about fifteen database round trips in one request (status lookups,
automation, notifications, stage sync, then a re-read of the task). That is the likely floor for write time. Look at the
`Slow request` warnings and the `Server-Timing` of a card move on production before deciding what to move off the request path.

## The architecture

One path for every write, in five steps. Pages describe *what* changes; the shared layer does *how* (`lib/optimistic.ts`,
`lib/MutationSync.tsx`, `lib/mutationEffects.ts`).

1. **Show it.** Before the request leaves, cancel reads of the affected data (so an older answer cannot land on top), then patch the cache
   with the new value. The screen changes in the same frame.
2. **Send it.** One request. Writes that fail for lack of a connection wait in the outbox (`lib/outbox.ts`) and are sent when it is back.
3. **Believe the server.** The write answers with the saved record: put *that* into the cache. Ids, times and computed fields come from the
   server; nothing is guessed twice.
4. **Refresh only what the change touches.** The transport reports the commit; the shared layer refreshes the mounted views of the affected
   families, once, after a short wait that merges a burst of saves. Screens do not call refresh themselves.
5. **Undo cleanly.** If the server refuses, the cache goes back to exactly what it was and one message says why.

Reads of the same data must share **one cache entry**. Two lists of the same tasks under different keys (the project's Plan and Board do
this today) are two things to keep in step; the next step is to read one and filter.

Realtime (the live feed) updates other people's and other tabs' views. A change made in *this* tab is skipped for a few seconds
(`committedHereRecently`) because step 3 already has it.

## Rules for new code

- A write is a mutation with `meta.optimistic` (see `lib/optimistic.ts`), not a bare call followed by `invalidateWorkspace`.
- Never `invalidateWorkspace(wid)` with no family and never `invalidateQueries()` with no key. The ceiling test fails if the count rises.
- Cancel reads before patching the cache by hand; put the server's answer back in the cache.
- A local "optimistic layer" (like the calendar's) is dropped when the server agrees with it, never when "some read arrived".
- Nothing a person waits for runs in the request unless the answer needs it. Notifications, automations and recomputation belong after the
  response (a queue), with the answer returning the saved record.

## Next, in order

1. Read `Server-Timing` for a card move, a calendar edit and a task create on production. Fix the largest share first.
2. Move notifications and automation off the request path for task moves and field saves.
3. Convert the board, plan list and calendar writes to `meta.optimistic` mutations and drop their hand-written refreshes; lower the ceiling
   as each goes.
4. One cache entry for a project's tasks.
