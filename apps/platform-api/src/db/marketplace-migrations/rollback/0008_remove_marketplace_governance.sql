DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM marketplace_governance_events)
     OR EXISTS (SELECT 1 FROM listings WHERE status='needs_changes')
     OR EXISTS (SELECT 1 FROM tool_manifests WHERE status='needs_changes') THEN
    RAISE EXCEPTION 'Marketplace governance rollback requires preserved history and needs-changes resources to be resolved first';
  END IF;
END $$;
DROP FUNCTION erase_tenant_marketplace_governance(uuid,text);
DROP TABLE marketplace_governance_events;
DROP FUNCTION prevent_marketplace_governance_mutation();
DROP TRIGGER listings_governance_revision ON listings;
DROP TRIGGER tool_manifests_governance_revision ON tool_manifests;
DROP FUNCTION advance_marketplace_governance_revision();
ALTER TABLE listings DROP COLUMN governance_revision;
ALTER TABLE tool_manifests DROP COLUMN governance_revision;
ALTER TABLE listings DROP CONSTRAINT listings_status_check;
ALTER TABLE listings ADD CONSTRAINT listings_status_check CHECK (status IN (
  'draft','private_testing','submitted','automated_review','human_review',
  'published','suspended','deprecated','removed'));
ALTER TABLE tool_manifests DROP CONSTRAINT tool_manifests_status_check;
ALTER TABLE tool_manifests ADD CONSTRAINT tool_manifests_status_check CHECK (status IN ('draft','published','blocked'));
