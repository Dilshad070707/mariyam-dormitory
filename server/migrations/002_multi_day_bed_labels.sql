ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS duration_days SMALLINT NOT NULL DEFAULT 1;

DO $$
DECLARE constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'bookings'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%expected_check_out%'
  LOOP
    EXECUTE format('ALTER TABLE bookings DROP CONSTRAINT %I', constraint_row.conname);
  END LOOP;
END $$;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_duration_check
  CHECK (duration_days BETWEEN 1 AND 30 AND expected_check_out = check_in + (duration_days * interval '24 hours'));
