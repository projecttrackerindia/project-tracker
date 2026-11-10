# Authorized evidence and forecast evaluation

Knowledge search (the `search_knowledge` tool, and the Ctrl/Cmd K ask bar's "Related by meaning" list through `GET /api/v1/search/meaning`) is hybrid: a word search over authorized project records, work items and documents, and a meaning search over an embedding index, merged and ranked together by reciprocal rank (something both find comes first). Each result says how it was found (`words`, `meaning` or `both`) and carries a short excerpt and a link. Meaning matches are related results, not proof, and nothing here is an accuracy claim; the wording in the app says so. Reads recheck current permissions, explicit document denies and published/draft visibility. Source versions can be supplied to reject stale reads. Excerpts are bounded. Retrieved references are attached by the server to saved answers; their presence does not prove every generated claim.

## Meaning search

What is indexed (`AiSearchChunks`, one row per piece of up to about 1,000 characters, vector stored as one signed byte per dimension, tenant scoped):

| Source | Indexed | Never indexed |
| --- | --- | --- |
| Tasks, operational work, action items | title and description | deleted items |
| Documents | search text of Public and Internal pages | Confidential and Restricted pages |
| Chat messages | text messages of the last 180 days, 30 characters or longer, in direct, group and project chats | private (end-to-end encrypted) chats, system lines, deleted messages |
| Meeting notes | the notetaker's minutes (summary, discussion, decisions, actions, risks) and the start of the transcript (12 pieces) | transcripts erased by the retention rules or the person's "delete transcript" choice |
| Project mail | mail received at a project's agent mailbox (first 3 pieces) | personal inboxes (Gmail, Outlook, IMAP): they are not stored, so they are not indexed |

Personal data is masked before embedding. Text kept encrypted at its source (minutes, transcripts, project mail) is embedded but its words are not copied into the index: the row keeps an empty `Text`, and the excerpt is cut from the live source, decrypted, when it is shown.

Indexing is incremental and cheap. A background worker (`AiSemanticWorker`, every two minutes) takes a bounded number of changed sources per pass (the budget is divided between the source kinds, at most 32 pieces per model call), hashes the text with the model name and embeds only what changed; an unchanged source only has its timestamp moved. Deleted, now-private, now-confidential and erased sources are dropped on the next pass. Workspaces that switched the assistant off are skipped and what was taken from their chat, meetings and mail is removed. The worker is idle when no embedding model is configured (`IAiEmbedder`; Gemini on Vertex is the live provider). A question costs one small embedding call.

Who may see a result is never decided by the index. Every candidate is re-opened at read time as the asker, by the rule that governs it everywhere else in the app, and left out when that fails:

- Documents: `DocumentService.GetAsync` (module access, explicit denies, draft versus published visibility).
- Work items and tasks: `WorkItemService` in the caller's scope.
- Chat messages: the asker must have a place in the conversation now (member row; for a project chat, the project's audience), the conversation must not be private, the message must be undeleted and not older than the asker's join. Guests and personal workspaces get no chat.
- Project mail: the asker must be able to open the project and be its owner, a member, or a workspace Owner or Admin.
- Minutes and transcripts: the asker must be able to open the project and either have sent the notetaker or be someone who may see the call it attended (started it, took part, is in its chat, or is on its project).

`read_knowledge` accepts the kinds `chat`, `minutes`, `transcript` and `mail` and goes through the same check.

Fallback: when the embedding model is not configured, fails or times out, search returns the word results with no error and the methodology string says `authorized-keyword`. The ask bar then lists word matches only.

Coverage and limits. A new message, minutes or mail is findable by meaning only after the next worker pass; word search sees it at once. A workspace is searched from at most 20,000 pieces held in memory. Only the start of a long transcript is embedded. Message-level indexing means a short reply with no context ("sounds good") is not indexed at all. Quality has not been measured against real workspaces; only the fake embedder is covered by automated tests.

Follow-up history with tracked evidence rechecks up to twenty distinct source versions. Stale, revoked or excessive evidence causes earlier turns to be omitted with an instruction to retrieve current evidence. Conversations with tracked sources do not generate or replay unversioned compacted summaries. Private transcript retention is separate from permission to reuse its evidence in a new model request. Legacy responses without tracked references are not a calibrated knowledge corpus.

Opt-in portfolio jobs capture forecast inputs with the result in a consistent database snapshot. Cancelled or superseded workers cannot commit a forecast. Partial reviews disclose their bounds and withhold delivery predictions. Accuracy views use actual server-audited Completed transitions, one latest eligible forecast per currently authorized project, and exclude changed scope, incomplete data and reopened or unfinished projects. Confidence remains heuristic, not calibrated probability. Evaluation is private to the requester and covers the last 90 days; no autonomous business write is enabled by a score.

Review admission is serialized per workspace: 20 pending reviews per person, 100 per workspace; five schedules per person, twenty per workspace. Overlapping scheduled reviews for the same requester, kind and team are deduplicated. Full queues defer schedules instead of creating more work. These limits protect SQL workers and do not certify 5,000 simultaneous AI conversations.

Hourly bounded maintenance expires saved review payloads after 30 days and forecast evidence after 90 days. Financial entries and business records are preserved. Review metadata and request keys remain available for deduplication.

Successful scheduled reviews create one private in-app notification if the requester allows report notifications. The notification contains no project content, links to the authorized result and is committed with the fenced result. It does not request email or push delivery.

Validation: 16 focused local tests passed for current tenant boundaries, document denies, stale versions, persistent job recovery, audited outcomes, credit accounting and the query-filter bypass guard. Frontend type checking passed. No live or bulk AI calls were made for these changes.
