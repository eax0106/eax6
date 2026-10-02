DROP INDEX runs_replay_request_unique;
ALTER TABLE runs DROP CONSTRAINT runs_replay_confirmation_check;
ALTER TABLE runs DROP CONSTRAINT runs_replay_event_tenant_fk;
ALTER TABLE runs DROP COLUMN replayed_from;
ALTER TABLE runs DROP COLUMN replay_confirmed_by;
ALTER TABLE runs DROP COLUMN replay_confirmed_at;
ALTER TABLE runs DROP COLUMN replay_actions;
ALTER TABLE runs DROP COLUMN replay_request_key;
ALTER TABLE runs DROP COLUMN replay_confirmation_token;
