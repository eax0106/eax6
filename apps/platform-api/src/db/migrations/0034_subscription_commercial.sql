-- D22 commercial configuration is unset until an owner configures launch values.
CREATE FUNCTION valid_plan_commercial(value jsonb) RETURNS boolean
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
ALTER TABLE plan_definitions ADD COLUMN commercial jsonb
  CHECK (valid_plan_commercial(commercial));
--> statement-breakpoint
CREATE UNIQUE INDEX plan_definitions_provider_plan_unique
  ON plan_definitions ((commercial->>'razorpayPlanId'))
  WHERE commercial->>'razorpayPlanId' IS NOT NULL;
--> statement-breakpoint
ALTER TABLE plan_definition_audit ADD COLUMN commercial jsonb
  CHECK (valid_plan_commercial(commercial));
--> statement-breakpoint
ALTER TABLE billing_profiles
  ADD COLUMN checkout_attempt_id uuid,
  ADD COLUMN gstin text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  ADD COLUMN commercial_snapshot jsonb CHECK (valid_plan_commercial(commercial_snapshot)),
  ADD COLUMN provider_plan_ref text,
  ADD COLUMN last_provider_event_at bigint NOT NULL DEFAULT 0 CHECK (last_provider_event_at >= 0);
--> statement-breakpoint
ALTER TABLE billing_dunning_audits ADD COLUMN actor_ref text;
