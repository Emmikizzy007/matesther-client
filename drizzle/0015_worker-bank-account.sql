-- 0015: worker bank account numbers for the Monthly Staff Bank Payment Schedule.
--
-- The bank schedule must print Staff Name, Bank Account Number and Amount
-- Payable. The account number did not exist anywhere in the schema, so it is
-- added here as a nullable column: no default, no fabricated values, and every
-- worker simply shows "not on file" until the Owner records a real number.
-- Readable and writable by the Owner only (application-level RBAC); never
-- returned to Project Manager or Worker sessions.

ALTER TABLE workers ADD COLUMN IF NOT EXISTS bank_account_number text;
