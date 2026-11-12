ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS identity_type TEXT,
  ADD COLUMN IF NOT EXISTS identity_ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS whatsapp_notified_at TIMESTAMPTZ;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_identity_type_check
  CHECK (identity_type IS NULL OR identity_type IN ('aadhaar','pan','voter','driving_license'));
