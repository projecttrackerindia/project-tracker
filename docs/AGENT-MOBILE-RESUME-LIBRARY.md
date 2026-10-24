# Agent, mobile conversations and supplied resume designs

This release standardizes My account's horizontal section navigation, renames Orbit AI to Agent, and replaces the mark with a code-native animated circuit A. Idle animation is subtle; busy animation follows the frame; reduced-motion preferences disable both. Workspace administration navigation is unchanged.

Mobile Agent and chat use a bounded visual viewport with separate content, composer and navigation rows. Navigation hides during keyboard entry and returns when the keyboard closes. Conversation history scrolls within its own area. VisualViewport resize and pan events handle keyboard geometry; the layout also works without that API. These checks do not replace an authenticated physical iPhone/Android keyboard check.

## Resume designs

Resume studio has twelve designs that differ in layout, not only in colour (they replaced the earlier 30 colour variants of one
layout). Seven are single-column: Classic, Modern, Minimal, Executive, Compact, Academic and Technical. They vary in centred or
left-aligned name, rules or none, margins from 30 to 60pt, and heading size. Five have a banner and a sidebar: Navy, Forest, Plum,
Light and Terracotta. Colours print well and read in greyscale.

The studio shows them once, as small drawings of the page, beside the preview. Designs outside the person's plan carry a lock.
Plan caps stay 2/5/8/10, and custom entitlements may grant all 12. The preview is drawn in the export's proportions (A4, 595pt
wide), so margins, heading sizes, centring and rules match the PDF. Sections with no text are left out, as in the export.
Purchased exports keep their stored bytes; a design no longer in the list cannot be picked for new exports.

PDFs use embedded Noto fonts and measured text wrapping. Both columns continue across pages; unsupported glyphs return a clear error with Word as an alternative. DOCX exports contain editable paragraphs and tables. Template/sample roles are catalog search metadata, never resume claims. Original supplied reference documents are not bundled in the application.

## Validation and rollout

- `ResumeTemplateRenderTests`: export all 12 designs, check that they are distinct, validate Word schema and assert customer text and watermark; verify long PDF content spans pages and retains its tail.
- `ResumeTests`: enforce plan access despite the complete public design catalog.
- `npm run test:ui`: production bundles, production CSP and synthetic APIs; all account section navigation, 12-design picker with locked designs and per-design margins, mobile composer bounds at 320/390/768/landscape widths, keyboard resize/restoration and reduced motion.
- No model calls, customer message sends, payment actions or bulk AI testing are required for these checks.

Deploy API and frontend after required CI passes. There are no database migrations or new environment variables. Do not redeploy PostgreSQL for this change. No integration or payment feature gate is enabled by this release.
