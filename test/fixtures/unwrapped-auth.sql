-- RLS enabled, but the policy uses a BARE auth.uid() (P3/P2) → re-evaluated per row.
-- Also a write policy (FOR ALL) with no WITH CHECK (P5/P3) → cross-tenant writes.
CREATE TABLE public.notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  body text
);
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notes_owner" ON public.notes
  FOR ALL TO authenticated
  USING (user_id = auth.uid());
CREATE INDEX notes_user_id_idx ON public.notes (user_id);
