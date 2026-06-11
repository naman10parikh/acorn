-- A migration with the classic 84M-row outage maker: a bare ADD CONSTRAINT CHECK that validates
-- immediately under AccessExclusive (SCENARIO #4 — 4h12m/$52,400). Also missing SET lock_timeout (P14).
ALTER TABLE public.orders
  ADD CONSTRAINT orders_amount_positive CHECK (amount > 0);
