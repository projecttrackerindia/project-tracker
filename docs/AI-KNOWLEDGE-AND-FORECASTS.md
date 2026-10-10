# Authorized evidence and forecast evaluation

Knowledge search combines authorized project records, work items and the existing document index. Reads recheck current permissions, explicit document denies and published/draft visibility. Source versions can be supplied to reject stale reads. Excerpts are bounded; this is keyword retrieval, not a semantic search accuracy claim. Retrieved references are attached by the server to saved answers; their presence does not prove every generated claim.

Opt-in portfolio jobs capture forecast inputs with the result in a consistent database snapshot. Cancelled or superseded workers cannot commit a forecast. Partial reviews disclose their bounds and withhold delivery predictions. Accuracy views use actual server-audited Completed transitions, one latest eligible forecast per currently authorized project, and exclude changed scope, incomplete data and reopened or unfinished projects. Confidence remains heuristic, not calibrated probability. Evaluation is private to the requester and covers the last 90 days; no autonomous business write is enabled by a score.

Review admission is serialized per workspace: 20 pending reviews per person, 100 per workspace; five schedules per person, twenty per workspace. Overlapping scheduled reviews for the same requester, kind and team are deduplicated. Full queues defer schedules instead of creating more work. These limits protect SQL workers and do not certify 5,000 simultaneous AI conversations.

Hourly bounded maintenance expires saved review payloads after 30 days and forecast evidence after 90 days. Financial entries and business records are preserved. Review metadata and request keys remain available for deduplication.

Successful scheduled reviews create one private in-app notification if the requester allows report notifications. The notification contains no project content, links to the authorized result and is committed with the fenced result. It does not request email or push delivery.

Validation: 16 focused local tests passed for current tenant boundaries, document denies, stale versions, persistent job recovery, audited outcomes, credit accounting and the query-filter bypass guard. Frontend type checking passed. No live or bulk AI calls were made for these changes.
