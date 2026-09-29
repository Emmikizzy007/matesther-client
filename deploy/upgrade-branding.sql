-- SAFE, NON-DESTRUCTIVE UPGRADE FOR AN EXISTING MATESTHER DATABASE.
-- Use only if you separately choose to upgrade the old prototype.
-- The new client site instead uses deploy/schema-only.sql in a NEW project.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS logo_data text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS logo_mime text;
