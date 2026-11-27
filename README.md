# Lab Control Teacher Dashboard

This standalone Vite frontend uses the shared **intranet quiz** Supabase
project in **umesh1424's Org**. The Java kiosk, browser extension, and database
migrations are maintained in the original Java PC Kiosk repository. This
frontend expects the existing kiosk schema and authorized teacher accounts.

## Run locally

Use Node.js 22.12 or newer. Copy .env.example to .env.local and set
VITE_SUPABASE_URL to https://kvwjpzowmqhwlehrbxwx.supabase.co. Set
VITE_SUPABASE_PUBLISHABLE_KEY to the project's sb_publishable_ key. Keep
passwords and privileged Supabase keys out of frontend files.

    npm ci
    npm test
    npm run dev

Open the localhost URL displayed by Vite and sign in with an enrolled
teacher account.

## Deploy

Use the repository root as the hosting root. Set the same two environment
variables in the hosting environment before building.

    npm run build

Publish the dist directory over HTTPS. Review the existing Supabase project's
Auth redirect configuration with the project administrator if enabling
password recovery on the hosted URL.

The included tests exercise the browser-side IndexedDB cache and sync logic.
Database and extension integration tests stay in the original repository.
