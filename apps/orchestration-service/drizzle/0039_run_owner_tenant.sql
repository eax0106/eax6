-- Design log §30, requirement 2: a service may name the tenant it acts for,
-- and that assertion is checked against data this service already owns. Row
-- security hides another tenant's run, so a mismatch looked exactly like a
-- missing run. This exposes only the owning tenant of one run id -- no other
-- column, no listing -- so a mismatch can be refused by name and audited.
CREATE FUNCTION run_owner_tenant(p_run_id text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id FROM runs WHERE id = p_run_id;
$$;
