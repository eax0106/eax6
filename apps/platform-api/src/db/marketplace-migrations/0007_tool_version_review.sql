ALTER TABLE tool_versions DROP CONSTRAINT tool_versions_status_check;
--> statement-breakpoint
ALTER TABLE tool_versions ADD CONSTRAINT tool_versions_status_check
  CHECK (status IN ('draft','scanning','scan_failed','scan_unavailable','review_pending','published','revoked'));
--> statement-breakpoint
ALTER TABLE tool_scan_reports ADD CONSTRAINT tool_scan_report_version_unique UNIQUE (id, tool_version_id);
--> statement-breakpoint
ALTER TABLE tool_versions
  ADD COLUMN latest_scan_report_id text,
  ADD COLUMN reviewed_scan_report_id text,
  ADD COLUMN review_decision text CHECK (review_decision IN ('approved','rejected')),
  ADD COLUMN reviewed_by text,
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN review_reason text,
  ADD CONSTRAINT tool_version_latest_scan FOREIGN KEY (latest_scan_report_id,id) REFERENCES tool_scan_reports(id,tool_version_id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT tool_version_reviewed_scan FOREIGN KEY (reviewed_scan_report_id,id) REFERENCES tool_scan_reports(id,tool_version_id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT tool_version_review_complete CHECK (
    (review_decision IS NULL AND reviewed_scan_report_id IS NULL AND reviewed_by IS NULL AND reviewed_at IS NULL AND review_reason IS NULL)
    OR (review_decision IS NOT NULL AND reviewed_scan_report_id IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND review_reason IS NOT NULL AND length(trim(review_reason)) > 0)
  );
--> statement-breakpoint
UPDATE tool_versions v SET latest_scan_report_id = (
  SELECT id FROM tool_scan_reports r WHERE r.tool_version_id=v.id ORDER BY scanned_at DESC,id DESC LIMIT 1
);
--> statement-breakpoint
-- A prior scan alone is not a recorded first-version staff decision.
UPDATE tool_versions v SET status = CASE WHEN EXISTS (
  SELECT 1 FROM tool_scan_reports r WHERE r.id=v.latest_scan_report_id AND r.verdict='clean' AND jsonb_array_length(r.findings_json)=0
) THEN 'review_pending' ELSE 'scan_failed' END, published_at=NULL WHERE status='published';
--> statement-breakpoint
UPDATE tool_manifests SET status='draft',updated_at=clock_timestamp() WHERE status='published';
