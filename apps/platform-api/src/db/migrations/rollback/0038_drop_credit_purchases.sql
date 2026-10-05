DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM credit_purchases) OR EXISTS(SELECT 1 FROM credit_purchase_events) THEN
    RAISE EXCEPTION 'credit purchase history must be erased before downgrade';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS list_due_credit_purchases(integer);
--> statement-breakpoint
DROP FUNCTION IF EXISTS erase_tenant_credit_purchases(uuid,text);
--> statement-breakpoint
DROP TABLE IF EXISTS credit_purchase_events;
--> statement-breakpoint
DROP TABLE IF EXISTS credit_purchases;
--> statement-breakpoint
DROP FUNCTION IF EXISTS protect_credit_purchase_events();
--> statement-breakpoint
DROP FUNCTION IF EXISTS protect_credit_purchase();
