CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS admin_users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','staff')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(phone)
);
CREATE TABLE IF NOT EXISTS beds (
  id BIGSERIAL PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK(category IN ('upper','lower')),
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','maintenance')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bookings (
  id BIGSERIAL PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  bed_id BIGINT REFERENCES beds(id),
  category TEXT NOT NULL CHECK(category IN ('upper','lower')),
  check_in TIMESTAMPTZ NOT NULL,
  expected_check_out TIMESTAMPTZ NOT NULL,
  actual_check_in TIMESTAMPTZ,
  actual_check_out TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected','cancelled','checked_in','checked_out')),
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK(payment_status IN ('pending','pending_verification','verified','rejected','refund_pending','refunded')),
  amount INTEGER NOT NULL CHECK(amount >= 0),
  advance_amount INTEGER NOT NULL CHECK(advance_amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(expected_check_out = check_in + interval '24 hours')
);
CREATE INDEX IF NOT EXISTS bookings_period_idx ON bookings(check_in, expected_check_out);
CREATE INDEX IF NOT EXISTS bookings_customer_idx ON bookings(customer_id);
DO $$ BEGIN
  ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
    EXCLUDE USING gist (bed_id WITH =, tstzrange(check_in, expected_check_out, '[)') WITH &&)
    WHERE (bed_id IS NOT NULL AND status IN ('confirmed','checked_in'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS payments (
  id BIGSERIAL PRIMARY KEY,
  booking_id BIGINT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  utr TEXT UNIQUE,
  amount INTEGER NOT NULL CHECK(amount >= 0),
  status TEXT NOT NULL DEFAULT 'pending_verification' CHECK(status IN ('pending','pending_verification','verified','rejected','refund_pending','refunded')),
  screenshot_url TEXT,
  verified_by BIGINT REFERENCES admin_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS business_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gallery (
  id BIGSERIAL PRIMARY KEY,
  image_url TEXT NOT NULL,
  alt_text TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  admin_id BIGINT REFERENCES admin_users(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO business_settings(key,value) VALUES
('business', '{"name":"MARIYAM DORMITORY","hindiName":"मरियम डॉरमेट्री","phone":"+91 85917 99375","email":"mariyamdormitory@gmail.com","address":"1ST FLOOR, TINWALA TERRACE, 25, Kambekar St, near HUMA CATERERS, Dongri, Mandvi, Mumbai, Maharashtra 400003, India","instagram":"https://www.instagram.com/mariyam.dormitory/","upiId":"paytm.s2guu35@pty","rating":"4.7","capacity":35,"advanceAmount":100,"upperPrice":350,"lowerPrice":400,"checkInTime":"10:00","checkOutTime":"10:00"}'),
('facilities', '["Full AC available 24x7","Drinking Water Purifier available 24x7","Clean Toilets and Bathrooms","Cleaning Staff available 24x7","Dormitory Open 24x7"]')
ON CONFLICT (key) DO NOTHING;
INSERT INTO beds(label, category)
SELECT 'U-' || lpad(n::text, 2, '0'), 'upper' FROM generate_series(1,18) n
ON CONFLICT(label) DO NOTHING;
INSERT INTO beds(label, category)
SELECT 'L-' || lpad(n::text, 2, '0'), 'lower' FROM generate_series(1,17) n
ON CONFLICT(label) DO NOTHING;
