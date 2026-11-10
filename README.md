# SmartRoute-Engine — Outreach Map MVP

This first implementation milestone provides a Google-authenticated admin entry and a read-only Outreach map backed by `NZMARIE_DATABASE_URL`.

## Local setup

1. Copy `.env.example` to `.env.local` and fill in the SmartRoute-specific OAuth client, a new auth secret, an administrator email allowlist, a restricted Maps browser key, and a dedicated read-only `nzmarie` connection string.
2. Register the Google OAuth callback URL `http://localhost:3000/api/auth/callback/google` for local development.
3. Install dependencies with `npm install`, then start with `npm run dev`.
4. Open `/admin`, sign in with an allowlisted Google account, and go to Outreach. Albany, Q3 2026, and Map are selected by default; choose another suburb or reporting period as needed.

The OAuth client and auth secret must be unique to SmartRoute. The allowlist is configured with `SMARTROUTE_ADMIN_EMAILS`; Google sign-in alone never grants access. The source database should use a dedicated read-only account. All database transactions are also opened in read-only mode. This milestone does not update Outreach status or write to the source database.

The map uses Google's AdvancedMarkerElement through `@vis.gl/react-google-maps`; configure `NEXT_PUBLIC_SMARTROUTE_GOOGLE_MAPS_MAP_ID` or reuse `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` from `.env` (the final fallback is Google's `DEMO_MAP_ID`). The map API is administrator-only and returns only address text, coordinates, and the derived status needed by the map. Selecting a colored marker opens its address, status, and a Google Maps link. Address status uses the migration-spec precedence `junk > sent > unsent`; a selected quarter uses its `outreach_property_quarter_status` and send-log records plus the global `properties.no_junk_mail` flag. If a valid report quarter has no per-address status row yet, its addresses remain Unsent unless a send log exists for that quarter. “All history” uses any send event and the current global Junk flag, so a historical quarter-only Junk mark does not permanently relabel an address. Unsent points are shown only when the source data has addresses with no send history and valid coordinates; a suburb or quarter with zero Unsent records correctly has no red points. Results with missing coordinates are counted but not plotted. The UI shows an explicit error rather than silently truncating a suburb with more than 5,000 source addresses.

Cards, List, dispatch actions, route planning, and the SmartRoute-owned database are not implemented in this first milestone. `Doc/SmartRoute-Engine迁移规格.md` remains the functional reference.

## Validation

- `npm test` runs the unit tests and enforces at least 80% line, function, and branch coverage across the core address-status, admin-access, map-result, reporting-period, and suburb-selection logic.
- `npm run lint`, `npm run typecheck`, and `npm run build` validate style, types, and the production application.
