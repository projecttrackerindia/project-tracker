-- Extra production indexes and partitioning notes for 50k-user deployment.
-- Run after validating query plans in staging.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_ws_created_desc ON tasks(workspace_id, created DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_ws_stage_created_desc ON tasks(workspace_id, stage, created DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_ws_user_read_ts_desc ON notifications(workspace_id, user_id, read, ts DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dm_ws_recipient_read_ts_desc ON direct_messages(workspace_id, recipient, read, ts DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_files_ws_ts_desc ON files(workspace_id, ts DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_ws_created_desc ON audit_log(workspace_id, created DESC);

-- Recommended when audit/notifications/direct_messages cross tens of millions of rows:
-- partition by RANGE(created month) or HASH(workspace_id), depending on your dominant query path.
