-- A migration that creates a public table but NEVER enables RLS.
-- The P1 violation: migration-created tables are not covered by Supabase's secure-by-default
-- (CVE-2025-48757, 170 apps). The anon key reads everything.
CREATE TABLE public.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  subject text NOT NULL,
  body text,
  created_at timestamptz NOT NULL DEFAULT now()
);
