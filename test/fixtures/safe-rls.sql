-- A correctly-hardened tenant table: RLS enabled, wrapped (select auth.uid()), BOTH USING + WITH CHECK,
-- the predicate column indexed, a service_role gate. acorn's lint should find ZERO error violations here.
CREATE TABLE public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "messages_service_role" ON public.messages
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "messages_tenant_isolation" ON public.messages
  FOR ALL TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

CREATE INDEX messages_user_id_idx ON public.messages (user_id);
