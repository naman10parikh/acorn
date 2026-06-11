-- A correctly-formed zero-downtime migration: lock_timeout set, NOT VALID + VALIDATE two-step,
-- CONCURRENTLY index. acorn's migration lint should find ZERO error violations here.
SET lock_timeout = '3s';
ALTER TABLE public.orders
  ADD CONSTRAINT orders_amount_positive CHECK (amount > 0) NOT VALID;
ALTER TABLE public.orders VALIDATE CONSTRAINT orders_amount_positive;
CREATE INDEX CONCURRENTLY orders_customer_idx ON public.orders (customer_id);
