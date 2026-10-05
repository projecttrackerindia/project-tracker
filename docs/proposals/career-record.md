# Proposal (draft for review, nothing built): My work record for résumés, LinkedIn and Naukri

**Status:** draft for discussion. No code has been written for this. Decide first whether it is worth building, then which phase.

## 1. The idea in one paragraph

People change roles, apply for promotions, earn certifications and finish hard projects. All the evidence of what they actually did already sits in Project Tracker: tasks they finished, projects they led, dates they recovered, hours they logged, comments, who they worked with. Today they rebuild that from memory when they update LinkedIn or Naukri. The feature: **a private "work record" that turns a person's own history into accurate, evidence-backed, copy-ready achievements**, which the person edits and takes wherever they want.

## 2. Is this a valid use case?

**Yes, with three conditions.** The need is real (updating a profile or résumé is a recurring, memory-based chore, and the evidence already exists here), and it is a retention feature: people who see their career grow inside the product stay with it. It is also a natural place for the assistant, which already works from real project data.

The conditions:

1. **It belongs to the person, not the company.** The record is the person's own view of their own contribution. The organization must be able to switch it off for its workspace, and some details (client names, internal figures, anything under an NDA) must never leave without the person's explicit choice.
2. **No automatic posting.** LinkedIn and Naukri do not offer a public way to write someone's experience or achievements into their profile, and automating a login or scraping would break their terms and risk people's accounts. The product prepares; the person pastes. (LinkedIn does have an "Add to profile" link for certifications that opens LinkedIn pre-filled; that is a safe, supported hand-off.)
3. **Nothing invented.** Every line must trace back to a record in the product, and the person approves each line. The assistant may phrase and summarize but never add a number, a title or a claim that the data does not support.

## 3. Who would use it, and when

| Moment | What they need |
|---|---|
| Changing jobs | A clean list of projects, scope, results and tools, per role, in résumé wording |
| Promotion or appraisal | Evidence for the period: what was delivered, how complex, how it compared with plan |
| Certification or course finished | A dated entry with proof and an "Add to LinkedIn" link |
| Hard problem solved (a recovered slip, a major migration) | A short write-up with before/after facts to keep for later |
| Freelancer or consultant | A shareable, read-only portfolio of delivered work for clients |
| Manager | Endorse an achievement so it carries weight ("confirmed by Priya M, project owner") |

## 4. What the feature would be (kept small)

**A. Work record (private by default).** Account → *My work record*. Entries are created two ways: suggested from activity (a project you led reaches Completed, a streak of on-time deliveries, a large task you closed, hours logged on a theme) or added by hand (certifications, courses, awards, responsibilities). Each entry has a title, period, role, outcome in plain words, skills, and **evidence links** back to the underlying projects and tasks.

**B. Evidence, not claims.** Where the data supports it the entry shows facts the product computed: delivered N tasks, finished X days ahead of or behind plan, team size, period, and whether the project owner confirmed it. These facts are read from the product, not typed.

**C. Assistant help with guardrails.** "Write this as three résumé bullets", "make it fit LinkedIn's description", "summarize my last year for my appraisal". Outputs use only the entry's facts, are shown as drafts, and carry a visible "from your records" marker. The person edits before anything is copied.

**D. Take it anywhere (no automation).**
- Copy-ready text per platform (résumé bullets, LinkedIn experience text, Naukri key-skills and summary).
- Download as a document or PDF.
- *Add to LinkedIn* link for certifications.
- Optional **read-only share link** with an expiry date and a redaction level the person chooses; the viewer sees a verified summary and who confirmed it. Revocable at any time.

**E. Confirmation by others (optional).** A project owner or manager can confirm an entry ("I confirm this person led X from Jan to Jun"). Confirmations are signed with the person's name and date and shown on the shared page. No confirmation, no badge; the entry is still the person's own.

## 5. Privacy and trust (the part that decides whether to build it)

- **Default private.** Nothing is visible to the organization or anyone else unless the person shares it.
- **Redaction before copy.** The person chooses a level: *full*, *anonymised* (no client or project names, figures rounded) or *skills only*. The preview shows exactly what will leave.
- **Workspace policy.** An owner can disable the feature, or limit it to the anonymised level, for confidentiality or regulated work.
- **What never goes in automatically:** comments, files, chat, other people's data, billing or customer information.
- **Leaving the company.** The record is the person's: they keep access to their record (not to the company's projects) after they leave, with names and figures already redacted. Needs a legal check.
- **Audit and consent.** Creating, sharing and revoking are in the person's own activity log; sharing needs an explicit action each time.
- **No profiling by the employer.** Nothing in this feature is used to rank people. The record is not a performance score and is not readable by managers unless the person shares it.

## 6. Why not automatic LinkedIn or Naukri updates?

- Neither offers a supported public API to write a member's experience or achievements. Unofficial automation breaks their terms and can get the person's account restricted.
- A profile is public. A person must decide, line by line, what to reveal; an automatic post could leak confidential work.
- The valuable part is the accurate, well-phrased content. Copying it takes seconds.

If either platform later offers a supported way to publish, it can be added as a person-initiated action behind the same approval step.

## 7. Plans and positioning

Suggested: the private record and copy-ready text on **Pro and above** (it pairs naturally with the mobile app and the assistant); sharing links and manager confirmations on **Business and above**; the organization-level policy on **Business and above**. The free plan could include a read-only "my year in numbers" teaser to show the value.

## 8. Build in phases (each phase is useful alone)

1. **Record and export (small).** Manual entries, a "suggested from activity" list, evidence links, copy and PDF. No assistant, no sharing. Validates whether people use it.
2. **Assistant drafting.** Résumé bullets, LinkedIn text and appraisal summaries from approved entries, with the guardrails above.
3. **Sharing and confirmations.** Expiring read-only link, redaction levels, manager confirmation, revocation.
4. **Organization policy and certifications.** Workspace switch, anonymised-only mode, certification entries with the *Add to LinkedIn* hand-off.

## 9. How we would know it works

- Share of active users who open the record in the 30 days around a role change or review cycle.
- Entries kept versus suggestions dismissed (are suggestions good?).
- Copies and exports per active user per quarter.
- Zero incidents of a redaction level leaking a name or figure (tested automatically).
- Support questions about confidentiality (should stay low).

## 10. Risks and open questions

- **Confidentiality in the person's favour but the company's data.** Needs a clear statement in the terms and a workspace switch before launch.
- **Accuracy of "suggested from activity".** A task count is not an achievement. Suggestions must be framed as prompts to write about, not as results.
- **Ownership after someone leaves.** Needs legal review (see section 5).
- **Different countries' expectations.** Résumé and profile conventions differ (India, US, EU); templates need local variants.
- **Fairness.** The record must not become a hidden ranking tool. Keep it out of manager dashboards.
- **Scope creep.** Avoid becoming a general résumé builder; stay with *evidence from the work done here*.

## 11. Questions for you

1. Which moment matters most to your customers: job change, appraisal, or freelance portfolio?
2. Should managers be able to *request* a confirmation, or only the person can ask?
3. Is a person allowed to keep their record after leaving a workspace?
4. Which plan should carry it?
5. Any markets where a specific profile format (for example a particular Naukri layout) should be a first-class output?

Once you answer these, phase 1 can be specified in detail and built.
