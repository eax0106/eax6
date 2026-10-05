-- D22 commercial configuration is unset until an owner configures launch values.
CREATE OR REPLACE FUNCTION valid_plan_commercial(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE field text;
BEGIN
  IF value IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(value) <> 'object' OR value->>'currency' IS DISTINCT FROM 'INR'
    OR NOT value ?& ARRAY['currency','basePriceMinor','razorpayPlanId','includedCredits','extraCreditPriceMinor','creditsPerVerifiedRun']
    OR value - ARRAY['currency','basePriceMinor','razorpayPlanId','includedCredits','extraCreditPriceMinor','creditsPerVerifiedRun'] <> '{}'::jsonb
  THEN RETURN false; END IF;
  IF value->'razorpayPlanId' <> 'null'::jsonb AND
     (jsonb_typeof(value->'razorpayPlanId') <> 'string' OR value->>'razorpayPlanId' !~ '^plan_[A-Za-z0-9]{1,100}$')
  THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['basePriceMinor','includedCredits','extraCreditPriceMinor','creditsPerVerifiedRun'] LOOP
    IF value->field <> 'null'::jsonb AND
       (jsonb_typeof(value->field) <> 'number' OR value->>field !~ '^[0-9]+$' OR (value->>field)::numeric > 1000000000)
    THEN RETURN false; END IF;
  END LOOP;
  IF value->'creditsPerVerifiedRun' = '0'::jsonb THEN RETURN false; END IF;
  RETURN true;
END;
$$;
--> statement-breakpoint
ALTER TABLE plan_definitions ADD COLUMN IF NOT EXISTS commercial jsonb
  CHECK (valid_plan_commercial(commercial));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS plan_definitions_provider_plan_unique
  ON plan_definitions ((commercial->>'razorpayPlanId'))
  WHERE commercial->>'razorpayPlanId' IS NOT NULL;
--> statement-breakpoint
ALTER TABLE plan_definition_audit ADD COLUMN IF NOT EXISTS commercial jsonb
  CHECK (valid_plan_commercial(commercial));
--> statement-breakpoint
ALTER TABLE billing_profiles
  ADD COLUMN IF NOT EXISTS checkout_attempt_id uuid,
  ADD COLUMN IF NOT EXISTS checkout_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS mutation_attempt_id uuid,
  ADD COLUMN IF NOT EXISTS mutation_kind text CHECK (mutation_kind IN ('change','cancel')),
  ADD COLUMN IF NOT EXISTS pending_plan text,
  ADD COLUMN IF NOT EXISTS pending_provider_plan_ref text,
  ADD COLUMN IF NOT EXISTS pending_commercial_snapshot jsonb CHECK (valid_plan_commercial(pending_commercial_snapshot)),
  ADD COLUMN IF NOT EXISTS gstin text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  ADD COLUMN IF NOT EXISTS commercial_snapshot jsonb CHECK (valid_plan_commercial(commercial_snapshot)),
  ADD COLUMN IF NOT EXISTS provider_plan_ref text,
  ADD COLUMN IF NOT EXISTS last_provider_event_at bigint NOT NULL DEFAULT 0 CHECK (last_provider_event_at >= 0);
--> statement-breakpoint
ALTER TABLE billing_dunning_audits ADD COLUMN IF NOT EXISTS actor_ref text;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS billing_subscription_plans (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  subscription_ref text NOT NULL,
  provider_plan_ref text NOT NULL,
  internal_plan text NOT NULL,
  commercial_snapshot jsonb NOT NULL CHECK (valid_plan_commercial(commercial_snapshot)),
  PRIMARY KEY (tenant_id,subscription_ref,provider_plan_ref)
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS billing_policy_state (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  email_verified boolean NOT NULL DEFAULT false,
  verified_by uuid REFERENCES users(id),
  policy_hash text CHECK (policy_hash IS NULL OR policy_hash ~ '^[0-9a-f]{64}$'),
  source_revision timestamptz,
  policy_payload jsonb,
  published_revision timestamptz
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS billing_credit_deliveries (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  payment_ref text NOT NULL CHECK (payment_ref ~ '^pay_[A-Za-z0-9]{1,100}$'),
  credits integer NOT NULL CHECK (credits BETWEEN 1 AND 1000000000),
  provider_event_id text NOT NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,payment_ref)
);
--> statement-breakpoint
DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['billing_policy_state','billing_credit_deliveries','billing_subscription_plans'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',target);
    EXECUTE format('DROP POLICY IF EXISTS billing_tenant_context ON %I',target);
    EXECUTE format($policy$CREATE POLICY billing_tenant_context ON %I
      USING (tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid)$policy$,target);
    EXECUTE format('DROP TRIGGER IF EXISTS billing_prevent_tenant_update ON %I',target);
    EXECUTE format('CREATE TRIGGER billing_prevent_tenant_update BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_tenant_id_update()',target);
  END LOOP;
END;
$$;
--> statement-breakpoint
GRANT SELECT ON billing_policy_state TO platform_provisioner;
--> statement-breakpoint
-- Bounded scheduler inventory contains tenant identifiers only; financial data
-- stays behind ordinary tenant transactions.
CREATE OR REPLACE FUNCTION list_billing_sync_tenants(after_id uuid, batch_size integer)
RETURNS TABLE(tenant_id uuid) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path FROM CURRENT SET row_security TO off AS $$
  SELECT b.tenant_id FROM billing_policy_state b JOIN tenants t ON t.id=b.tenant_id
    WHERE (after_id IS NULL OR b.tenant_id>after_id) AND t.status='active'
    ORDER BY b.tenant_id LIMIT LEAST(GREATEST(batch_size,1),100)
$$;
--> statement-breakpoint
ALTER FUNCTION list_billing_sync_tenants(uuid,integer) OWNER TO platform_provisioner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION list_billing_sync_tenants(uuid,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION list_billing_sync_tenants(uuid,integer) TO platform_api;
