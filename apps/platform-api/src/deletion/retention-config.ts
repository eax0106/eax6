/**
 * Retention and erasure rules for platform_db (D2, design log section 18).
 *
 * Configuration, in one reviewed place. The legal periods are an engineering
 * reading of Indian law, to be confirmed with the company's CA before launch:
 * they are not legal advice.
 */

/** What the law says must outlive a tenant, by kind (months, from the day the tenant is erased). */
export const LEGAL_HOLD_MONTHS = {
  /** Tax invoices and billing records (GST), about 72 months. */
  tax_invoice: 72,
  /** Books of account (Companies Act), about 8 years. */
  books_of_account: 96,
  /** Seller KYC records (PMLA), about 5 years after the relationship ends. */
  seller_kyc: 60,
  /** Seller payouts (PMLA), about 5 years after the relationship ends. */
  seller_payout: 60,
} as const;

export type LegalHoldKind = keyof typeof LEGAL_HOLD_MONTHS;

/** The minimised audit skeleton and staff access logs are destroyed this long after erasure (D2). */
export const SKELETON_RETENTION_DAYS = 90;

/**
 * Tables whose rows are not destroyed when a tenant is erased, because they are
 * staff access records kept for SKELETON_RETENTION_DAYS (D2). The retention
 * sweeper destroys them, with the tenant's tombstone, when that time is up.
 */
export const SKELETON_TABLES = [
  "tenant_admin_actions",
  "jit_grants",
  "jit_grant_audit",
  "user_admin_actions",
] as const;

/**
 * Rows reduced to their minimum fields and copied to legal_hold_records before
 * the tenant's own rows are destroyed. Only the columns named here are kept:
 * never a document, a payload or a name.
 */
export const LEGAL_HOLD_SOURCES: readonly {
  readonly table: string;
  readonly kind: LegalHoldKind;
  readonly idColumn: string;
  readonly columns: readonly string[];
}[] = [
  { table: "billing_events", kind: "tax_invoice", idColumn: "provider_event_id", columns: ["provider_id", "provider_event_id", "type", "created_at"] },
  { table: "orders", kind: "books_of_account", idColumn: "id", columns: ["id", "listing_id", "listing_version_id", "amount_minor", "currency", "status", "payment_reference", "created_at"] },
  { table: "payouts", kind: "seller_payout", idColumn: "id", columns: ["id", "order_id", "publisher_id", "total_minor", "seller_share_minor", "platform_share_minor", "status", "created_at"] },
  { table: "payout_ledger", kind: "seller_payout", idColumn: "id", columns: ["id", "payout_id", "entry_type", "amount_minor", "created_at"] },
  { table: "kyc_submissions", kind: "seller_kyc", idColumn: "id", columns: ["id", "publisher_id", "status", "submitted_at", "reviewed_at"] },
];
