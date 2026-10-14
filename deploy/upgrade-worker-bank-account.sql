-- Hand-run CLIENT database upgrade for worker bank account numbers
-- (Monthly Staff Bank Payment Schedule, migration 0015).
-- Back up and confirm the correct Supabase project first; test on staging.
-- Additive and repeatable: ONE nullable column, no defaults, no seeds, and no
-- historical updates. Existing workers simply show "not on file" on the bank
-- schedule until the Owner records a real account number - the application
-- never fabricates one. SQL first, deploy app AFTER COMMIT and verification.
-- Do NOT run drizzle-kit migrate against a Supabase client.
BEGIN;

ALTER TABLE workers ADD COLUMN IF NOT EXISTS bank_account_number text;

-- workers already carries organization-scoped RLS and revoked direct
-- anon/authenticated access from the earlier upgrades (0004/0010); adding a
-- column does not change any policy. The account number is exposed only by
-- the Owner-only endpoints (workers API for the Owner session, payment-sheet
-- API), never to Project Manager or Worker sessions.

COMMIT;

-- Verification (expect 1):
-- SELECT COUNT(*) FROM information_schema.columns
--  WHERE table_name = 'workers' AND column_name = 'bank_account_number';
