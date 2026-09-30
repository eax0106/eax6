DROP FUNCTION IF EXISTS erase_tenant_listings(uuid, text);
DROP FUNCTION IF EXISTS erase_tenant_payout_ledger(uuid, text);
CREATE OR REPLACE FUNCTION reject_payout_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payout_ledger is append-only';
END;
$$;
REVOKE SELECT, DELETE ON "payout_ledger" FROM platform_erasure;
