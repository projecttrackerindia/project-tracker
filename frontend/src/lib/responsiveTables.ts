import { isMobileNow } from './mobile';

/**
 * Phones do not scroll tables sideways: each row becomes a card, with the column's name beside every value. The tables themselves stay as they
 * are (this only adds `rt` and a `data-label` to each cell, which the phone styles turn into cards); a grid that only makes sense as a grid
 * (the access matrix, hours by day) opts out with `data-grid` or one of the classes below.
 */
const GRID = '.sla-matrix, .matrix, .ts-table, [data-grid]';

function enhance(table: HTMLTableElement) {
  if (table.matches(GRID)) return;
  const head = table.tHead?.rows[table.tHead.rows.length - 1];
  if (!head) return;
  const labels = Array.from(head.cells).flatMap((c) => Array(Math.max(1, c.colSpan)).fill((c.textContent ?? '').trim()) as string[]);
  table.classList.add('rt');
  for (const body of Array.from(table.tBodies)) for (const row of Array.from(body.rows)) {
    let col = 0;
    for (const cell of Array.from(row.cells)) {
      if (cell.dataset.label === undefined || cell.dataset.auto === '1') { cell.dataset.label = labels[col] ?? ''; cell.dataset.auto = '1'; }
      // A cell with nothing in it (no text, no control) would only show a lonely label.
      cell.dataset.empty = !(cell.textContent ?? '').trim() && !cell.querySelector('input,select,button,textarea,a,img,svg,progress') ? '1' : '';
      col += Math.max(1, cell.colSpan);
    }
  }
}

function sweep(root: ParentNode) { root.querySelectorAll('table').forEach((t) => enhance(t as HTMLTableElement)); }

/** Starts watching the page; cheap, and does nothing on a computer. */
export function startResponsiveTables() {
  if (typeof document === 'undefined') return;
  let queued = false;
  const run = () => { queued = false; if (isMobileNow()) sweep(document); };
  const watch = new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(run); } });
  watch.observe(document.body, { childList: true, subtree: true });
  matchMedia('(max-width: 768px), (pointer: coarse) and (max-height: 500px)').addEventListener('change', run);
  run();
}
