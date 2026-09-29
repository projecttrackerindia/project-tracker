/**
 * The product's mark: a checkmark whose rising stroke ends in a solid node, read at once as "task done" and
 * "trending up." Renders the same gradient badge used everywhere as `.brand-mark` (see styles/base.css); this
 * component only supplies the glyph inside it, so it drops into the existing sidebar/auth markup unchanged.
 */
export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
      <path d="M5.5 12.5l4 4L14 10" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 10l3.2-3.6" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="18.3" cy="5.7" r="2.1" fill="#fff" />
    </svg>
  );
}
