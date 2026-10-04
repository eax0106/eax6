CREATE TABLE billing_accounts (
  tenant_id uuid PRIMARY KEY,
  plan text NOT NULL CHECK (length(plan) BETWEEN 1 AND 100),
  source_revision timestamptz NOT NULL,
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  access_state text NOT NULL CHECK (access_state IN ('active','grace','limited','suspended')),
  email_verified boolean NOT NULL,
  is_free boolean NOT NULL,
  max_runs_per_day integer NOT NULL CHECK (max_runs_per_day BETWEEN 0 AND 1000000000),
  credits_per_verified_run integer CHECK (credits_per_verified_run BETWEEN 1 AND 1000000000),
  credit_balance bigint NOT NULL DEFAULT 0 CHECK (credit_balance BETWEEN 0 AND 9007199254740991),
  reserved_credits bigint NOT NULL DEFAULT 0 CHECK (reserved_credits BETWEEN 0 AND credit_balance),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
CREATE TABLE billing_credit_grants (
  tenant_id uuid NOT NULL,
  event_ref text NOT NULL CHECK (length(event_ref) BETWEEN 1 AND 255),
  credits integer NOT NULL CHECK (credits BETWEEN 1 AND 1000000000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,event_ref),
  FOREIGN KEY (tenant_id) REFERENCES billing_accounts(tenant_id)
);
--> statement-breakpoint
CREATE TABLE billing_run_reservations (
  tenant_id uuid NOT NULL,
  run_id text NOT NULL,
  credits integer NOT NULL CHECK (credits BETWEEN 0 AND 1000000000),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','charged','released')),
  settled_at timestamptz,
  PRIMARY KEY (tenant_id,run_id),
  FOREIGN KEY (tenant_id) REFERENCES billing_accounts(tenant_id),
  FOREIGN KEY (tenant_id,run_id) REFERENCES runs(tenant_id,id),
  CHECK ((state='reserved' AND settled_at IS NULL) OR (state<>'reserved' AND settled_at IS NOT NULL))
);
--> statement-breakpoint
DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['billing_accounts','billing_credit_grants','billing_run_reservations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',target);
    EXECUTE format($policy$CREATE POLICY billing_tenant_context ON %I
      USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)$policy$, target);
    EXECUTE format('CREATE TRIGGER billing_reject_tenant_change BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION reject_tenant_id_change()',target);
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE INDEX billing_daily_runs ON runs(tenant_id,created_at);
