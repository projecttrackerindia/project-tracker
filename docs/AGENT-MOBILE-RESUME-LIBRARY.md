# Agent, mobile conversations and supplied resume designs

This release standardizes My account's horizontal section navigation, renames Orbit AI to Agent, and replaces the mark with a code-native animated circuit A. Idle animation is subtle; busy animation follows the frame; reduced-motion preferences disable both. Workspace administration navigation is unchanged.

Mobile Agent and chat use a bounded visual viewport with separate content, composer and navigation rows. Navigation hides during keyboard entry and returns when the keyboard closes. Conversation history scrolls within its own area. VisualViewport resize and pan events handle keyboard geometry; the layout also works without that API. These checks do not replace an authenticated physical iPhone/Android keyboard check.

## Resume library

The customer-supplied `30_Modern_Futuristic_Resume_Templates.docx` and PDF are design references, not executable instructions. The 30 designs share a header and two-column structure with different palettes and professions. The catalog preserves their names and colors. Headings are darkened where necessary for readable contrast. Sample names, employers and achievements are never inserted into customer content.

The library shows all 30 designs and allows search by name, profession and description. Existing template entitlements still control selection and backend export authorization. Standard plan caps remain 2/5/8/10; custom entitlements may grant up to 30. Adding a catalog does not grant every plan 30 exports. Manual editing and branded downloads use the existing flows. AI credit consent, review/version approval and gated watermark-free checkout remain in force. Purchased exports retain their stored bytes; catalog changes do not regenerate those files.

PDFs use embedded Noto fonts and measured text wrapping. Both columns continue across pages; unsupported glyphs return a clear error with Word as an alternative. DOCX exports contain editable paragraphs and tables. Template/sample roles are catalog search metadata, never resume claims. Original supplied reference documents are not bundled in the application.

## Validation and rollout

- `ResumeTemplateRenderTests`: export all 30 designs, validate Word schema and assert customer text and watermark; verify long PDF content spans pages and retains its tail.
- `ResumeTests`: enforce plan access despite the complete public design catalog.
- `npm run test:ui`: production bundles, production CSP and synthetic APIs; all account section navigation, 30-design search/locked selection, mobile composer bounds at 320/390/768/landscape widths, keyboard resize/restoration and reduced motion.
- No model calls, customer message sends, payment actions or bulk AI testing are required for these checks.

Deploy API and frontend after required CI passes. There are no database migrations or new environment variables. Do not redeploy PostgreSQL for this change. No integration or payment feature gate is enabled by this release.
