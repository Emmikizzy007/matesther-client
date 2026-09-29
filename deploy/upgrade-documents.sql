-- Matesther customer documents upgrade for an EXISTING Supabase project.
-- Safe for existing orders, payments, deliveries and logo. No TRUNCATE or DROP.
-- Run once in Supabase SQL Editor before deploying the updated app.
CREATE TABLE IF NOT EXISTS public.delivery_lines (
  id serial PRIMARY KEY,
  delivery_id integer NOT NULL REFERENCES public.deliveries(id) ON DELETE CASCADE,
  order_item_id integer REFERENCES public.order_items(id) ON DELETE SET NULL,
  description text NOT NULL,
  size text,
  quantity integer NOT NULL CHECK (quantity > 0)
);
ALTER TABLE public.delivery_lines ENABLE ROW LEVEL SECURITY;
DO $matesther_documents$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.delivery_lines FROM anon;
    REVOKE ALL ON SEQUENCE public.delivery_lines_id_seq FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.delivery_lines FROM authenticated;
    REVOKE ALL ON SEQUENCE public.delivery_lines_id_seq FROM authenticated;
  END IF;
END $matesther_documents$;
