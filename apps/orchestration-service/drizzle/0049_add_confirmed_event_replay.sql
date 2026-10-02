ALTER TABLE runs ADD COLUMN replayed_from text;
ALTER TABLE runs ADD COLUMN replay_confirmed_by uuid;
ALTER TABLE runs ADD COLUMN replay_confirmed_at timestamptz;
ALTER TABLE runs ADD COLUMN replay_actions jsonb;
ALTER TABLE runs ADD COLUMN replay_request_key text;
ALTER TABLE runs ADD COLUMN replay_confirmation_token text;
ALTER TABLE runs ADD CONSTRAINT runs_replay_event_tenant_fk
  FOREIGN KEY (tenant_id, replayed_from) REFERENCES events (tenant_id, event_id);
ALTER TABLE runs ADD CONSTRAINT runs_replay_confirmation_check CHECK (
  (replayed_from IS NULL AND replay_confirmed_by IS NULL AND replay_confirmed_at IS NULL AND replay_actions IS NULL
    AND replay_request_key IS NULL AND replay_confirmation_token IS NULL)
  OR (replayed_from IS NOT NULL AND replayed_from = triggering_event_id AND replay_confirmed_by IS NOT NULL
    AND replay_confirmed_at IS NOT NULL AND replay_actions IS NOT NULL AND jsonb_typeof(replay_actions) = 'array'
    AND replay_request_key IS NOT NULL AND replay_confirmation_token IS NOT NULL)
);
CREATE UNIQUE INDEX runs_replay_request_unique ON runs (tenant_id, replay_request_key);
