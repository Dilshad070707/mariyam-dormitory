# MARIYAM DORMITORY

Mobile-first public booking website with a separate staff dashboard, Express API, and PostgreSQL database. The default inventory contains 35 beds (18 upper and 17 lower). Rates are per bed for one fixed 24-hour booking starting at 10:00 AM India time.

## What is included

- Public website with business details, facilities, prices, location link, WhatsApp and Instagram links, availability search, booking request, booking lookup, and UPI reference submission.
- Public availability now lists the actual available bed labels. Customers can request a stay of 1–30 fixed 24-hour days; rates multiply by selected days, and checkout remains at 10:00 AM.
- Separate `/admin/login` dashboard for booking and payment review, check-in/check-out, customer list, bed maintenance, and editing each bed's display name and upper/lower type.
- PostgreSQL migrations with seeded business information and 35 beds, unique UTR values, audit records, and a database exclusion constraint preventing overlapping confirmed allocations.
- Server-side price calculation, 24-hour UTC instants from Asia/Kolkata check-in dates, password hashing, HTTP-only session cookies, login throttling, parameterized SQL, and expiring 30-minute pending bed holds.
- Render Blueprint (`render.yaml`) and environment template.

Payment is manual. The site never confirms a payment because a guest typed a UTR. Staff must check their bank/UPI records and verify it in the dashboard. The public site does not print the UPI ID; after a booking request it generates an amount-specific UPI QR for the selected full stay.

Booking requests require an ID document type and number. The number is encrypted in PostgreSQL using AES-256-GCM with a key derived from `IDENTITY_ENCRYPTION_KEY` or `SESSION_SECRET`; only signed-in staff can view it for an in-person check-in match. The encrypted number is cleared at check-in, checkout, cancellation, rejection, or expiry. Keep the production `SESSION_SECRET` stable and private. Guests can use **My profile** with a one-time code sent to the email used for booking. They can return later, recover booking references, see payment and staff-confirmation status, pay with a regenerated QR, and submit a UTR. Email-code sign-in and confirmation emails require `RESEND_API_KEY` and a verified `RESEND_FROM_EMAIL` in Render. WhatsApp confirmation is sent after the same approval when the guest opted in and WhatsApp Cloud API credentials plus an approved message template are configured. Without the provider credentials, staff must contact guests manually. The 20-minute message is an operational estimate, not an automatic payment guarantee.

## Run locally

Requirements: Node.js 20+, PostgreSQL 14+ (with `btree_gist` extension support).

1. Create a PostgreSQL database named `mariyam_dormitory`.
2. Copy `.env.example` to `.env`; set `DATABASE_URL`, a long random `SESSION_SECRET`, and `APP_ORIGIN=http://localhost:3000`.
3. Install dependencies with `npm install`.
4. Create tables and seed initial settings and beds: `npm run db:migrate`.
5. Create an administrator using the interactive secure command: `npm run admin:create`. Choose a unique email and a password of at least 12 characters. No public registration page exists.
6. Start the app: `npm start`; visit `http://localhost:3000` and `/admin/login`.

To add another admin, run `npm run admin:create` again with a different email. The command never prints or stores the plain password.

## Deploy on Render

1. Create a private or public GitHub repository and push this folder. Never commit `.env`.
2. In Render, choose **New → Blueprint**, connect the repository, and let Render create the web service and PostgreSQL database from `render.yaml`.
3. Render supplies the web service's internal `DATABASE_URL` and generates a private `SESSION_SECRET`. This Blueprint uses free plans for an initial preview, so no payment card should be needed. The app checks same-origin requests automatically; `APP_ORIGIN` is optional if you want to pin a specific site origin.
4. The web service runs `npm run db:migrate` at startup and applies any pending SQL migration before serving requests. Keep the admin account credentials private and open `/admin/login` on the deployed site to sign in.
5. Add `RESEND_API_KEY` and `RESEND_FROM_EMAIL` to the web service's Render environment to enable confirmation email. WhatsApp messages need the four WhatsApp settings listed above. The customer receives email/WhatsApp only after both payment verification and booking confirmation.
6. Check `/api/health`, make a small test booking request, and verify staff can sign in before sharing the site.

Render's internal URL is intended for the hosted app; use the external URL from your laptop. Render requires TLS for external Postgres connections. The free database expires after 30 days and has no backups, and the free web service can sleep when idle; use this only as a test deployment. For real dormitory bookings, choose a paid database and arrange backups before collecting customer data. Back up the Render PostgreSQL database before applying future schema changes.

## API overview

Public: `GET /api/public/settings`, `GET /api/availability?date=YYYY-MM-DD&category=upper&count=1`, `POST /api/bookings`, `GET /api/bookings/:reference`, `POST /api/profile/request-code`, `POST /api/profile/verify-code`, `GET /api/profile/me`, `GET /api/profile/bookings`, `POST /api/profile/logout`, `POST /api/payments`.

Staff (session protected): `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/summary`, `GET /api/admin/bookings`, `PATCH /api/admin/bookings/:id`, `GET /api/admin/beds`, `PATCH /api/admin/beds/:id`, `GET /api/admin/payments`, `GET /api/admin/customers`.

The admin-only business settings write API is `PUT /api/admin/settings/business`.

## Current scope notes

The UI and database provide a working booking and manual-verification baseline. The following parts of the broad brief still need implementation before treating this as a complete production operations system: staff account/role management, bed create/delete/category and specific bed reassignment controls, gallery upload, payment screenshot upload, refund recording and cancellation reason workflow, admin date filters and exception-time fields, real map embed/verified coordinates, and automated test coverage. No coordinates, gallery assets, or additional facility claims were invented. Replace the placeholder domain in `public/sitemap.xml` before launch. The public terms text is a starting point and should be reviewed by the business before publication.

For every update, push the code to GitHub. If `render.yaml` changed, use **Manual Sync** in the Render Blueprint so the service startup command and generated encryption key configuration are applied.
