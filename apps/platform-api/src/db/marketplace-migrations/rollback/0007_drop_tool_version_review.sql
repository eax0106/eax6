UPDATE tool_versions SET status='draft',published_at=NULL WHERE status='review_pending';
ALTER TABLE tool_versions DROP CONSTRAINT tool_version_review_complete;
ALTER TABLE tool_versions DROP CONSTRAINT tool_version_reviewed_scan;
ALTER TABLE tool_versions DROP CONSTRAINT tool_version_latest_scan;
ALTER TABLE tool_versions DROP COLUMN review_reason, DROP COLUMN reviewed_at, DROP COLUMN reviewed_by,
  DROP COLUMN review_decision, DROP COLUMN reviewed_scan_report_id, DROP COLUMN latest_scan_report_id;
ALTER TABLE tool_scan_reports DROP CONSTRAINT tool_scan_report_version_unique;
ALTER TABLE tool_versions DROP CONSTRAINT tool_versions_status_check;
ALTER TABLE tool_versions ADD CONSTRAINT tool_versions_status_check
  CHECK (status IN ('draft','scanning','scan_failed','scan_unavailable','published','revoked'));
