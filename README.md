# 2A Group Corp - Petition Platform

Client portal, staff dashboard and automatic petition assembly for 2A Group Corp, on **Supabase** (database, sign-in, file storage, live updates) and **n8n** (automation).

- **Client portal**: an installable app for phone or desktop. Clients get an email invitation, choose a password, then upload documents (a phone photo works), answer intake questions and message the office. Changes show up live.
- **Staff dashboard**: overview (open cases, ready to build, awaiting attorney, waiting on client, deadlines), case list with filters, readiness checks, intake answers, document review, petition package, attorney approval, messages with internal notes, and an activity log. On a phone the case list and the case open as separate screens.
- **Assembly**: one PDF with the cover letter, forms, exhibit index and **EXHIBIT 1..N** tab pages in the firm's layout, followed by each exhibit's documents. Drafts carry a "pending attorney review" banner. The printable final is created only when an **attorney account** approves it.
- **Automation**: database changes are sent to n8n, which builds the draft as soon as a case is complete, messages clients, and sends reminders. See [What runs automatically](#what-runs-automatically).

Do not put real client data in the local test database. See [Before real client data](#before-real-client-data).

## Run it locally

Needs Node 20+ and Docker Desktop (already running n8n).

```bash
npm install
npm run db:start      # local Supabase in Docker (first run downloads its images)
npm run setup         # writes .env from the local Supabase keys + an automation key
npm run seed          # 6 demo accounts and 3 fictional cases
npm start             # http://localhost:3000
npm run n8n:import    # loads the n8n workflows with this install's key and restarts n8n
```

Demo sign-ins (admin, attorney, case manager, three clients) are written to `data/demo-logins.txt` on every seed.

Local tools: Supabase Studio (browse tables) at http://127.0.0.1:54323, and the test inbox that catches every email (invitations, sign-in links, password resets) at http://127.0.0.1:54324.

## Desktop icon (this computer)

```bash
powershell -ExecutionPolicy Bypass -File scripts/install-desktop-icon.ps1
```

This puts a **2A Portal** icon on the desktop and in the Start menu. Double-clicking it runs `scripts/launch-app.ps1`, which:
- starts whatever is not running: Docker Desktop, Supabase, n8n and the portal server, which keeps running in the background
- opens the portal in its own app window (Chrome or Edge)

If something fails, a message box points to `data/launcher.log`.

## Install as an app

The portal is a Progressive Web App, so the same build works on desktop and phone:

- **Desktop (Chrome or Edge)**: open the portal and click the install icon in the address bar. It opens in its own window with its own icon.
- **Android (Chrome)**: menu > Install app.
- **iPhone (Safari)**: Share > Add to Home Screen.

Only the app shell (pages, styles, scripts, icons) is cached on the device. Case data and files are always fetched from the server and never stored offline. Installing needs HTTPS when it is not on `localhost`. For the App Store and Google Play later, wrap the same web app with Capacitor, and use Tauri for a native desktop installer. The API and database stay the same.

## Database (Supabase)

The schema is in `supabase/migrations/`:

| Table | Holds |
| --- | --- |
| `profiles` | One row per person, with role `client`, `staff`, `attorney` or `admin` (set by the server only) |
| `cases` | Case type, stage, intake answers, USCIS receipt number, readiness summary |
| `case_team` | Staff assigned to a case |
| `documents` | Uploaded files (stored in the private `case-documents` bucket), review status and notes |
| `messages` | Client and staff messages, internal notes, automatic messages, read receipts |
| `packages` | Each assembled draft and final (private `packages` bucket), approval or return |
| `deadlines` | Dates from the USCIS timing rules |
| `audit_log` | Every view, edit, upload, build, approval and download. Append-only, enforced by a trigger. |
| `automation_events` | Every event sent to n8n |

**Security**
- Sign-up is closed. People join only by invitation: staff add a client email when they create a case; an admin invites staff from **Account**.
- Row Level Security is on for every table. Clients can read only their own documents and non-internal messages. Staff can read every case except restricted ones (asylum, VAWA, T-Visa), which only the assigned team, attorneys and admins can open (8 U.S.C. 1367, 8 CFR 208.6).
- All writes go through the server, which applies the presets, hides staff-only questions from clients, checks each file's content (real PDF, JPG or PNG), and logs the action.
- Only attorney and admin accounts can approve or return a petition.
- Staff can turn on two-step verification (authenticator app) under **Account**. Set `REQUIRE_STAFF_MFA=true` in `.env` to make it mandatory.
- The service role key in `.env` bypasses every security rule. Keep it on the server only, never in the app.

## What runs automatically

Database triggers record each change in `automation_events` and post it to the n8n webhook `case-event`. The webhook body carries only ids. n8n then calls the server with the automation key to get the details.

| When this happens | n8n does this |
| --- | --- |
| A case gets a client account | Sends a welcome message with how to start |
| The last required item arrives (case becomes ready) | Builds the draft petition package |
| The draft is built | Tells the client the attorney is reviewing (first version only) and adds an internal note |
| Staff reject a document | Messages the client with the file, the item and what to fix |
| The attorney approves | Tells the client the petition is being printed and filed |
| The attorney returns a draft | Adds an internal note for the team |
| Stage set to Filed, Receipt received, Biometrics, Interview or Decision | Sends the client a plain-language update (with the receipt number when entered) |
| Every day at 7am | Rechecks every open case against the USCIS timing rules, reminds clients who have had missing items for a week (at most weekly), and writes a staff digest of deadlines in the next 30 days |
| Every Monday at 8am (off until you connect an alert) | Compares the form editions on uscis.gov with the presets |

Workflows in `n8n/`:
- `case-events.workflow.json`: the event handling above.
- `daily-reminders.workflow.json`: the daily job.
- `petition-assembly.workflow.json`: a manual webhook `assemble-petition` that builds a package, or messages the client with what is missing.
- `uscis-edition-check.workflow.json`: the weekly edition check.

`npm run n8n:import` fills in the automation key and the server address, then imports them. To change the wording of automatic messages, edit `scripts/build-workflows.js`, then run `npm run n8n:build` and `npm run n8n:import`.

The staff digest and the edition alert end in placeholder steps. Connect your email or Slack in n8n to send them.

**n8n timezone:** the workflows set their own timezone to `America/New_York`. The n8n container was started with `TZ=US/Florida`, which is not a valid timezone name and makes every n8n expression fail. Recreate the container with `-e TZ=America/New_York -e GENERIC_TIMEZONE=America/New_York`, keeping the same data volume.

## Going live on Supabase Cloud

1. Create a project at supabase.com. Pick a US region, and sign Supabase's BAA if your policy requires one.
2. Link it and push the schema:

   ```bash
   npx supabase link --project-ref <ref>
   npx supabase db push
   ```

3. In the dashboard:
   - **Authentication**: turn off sign-ups, set the Site URL and redirect URL to `https://<your domain>/login.html`, and connect your own SMTP sender.
   - **Table editor**: set the `app_settings` value `n8n_event_url` to your public n8n webhook URL.
4. Host the Node server behind HTTPS. Set `.env` from the project's API settings: `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`. Also set `PUBLIC_URL` and a new `AUTOMATION_KEY`.
5. Set `N8N_API_BASE` to the server's address as n8n sees it, then run `npm run n8n:import`.
6. Create the first admin account in Supabase Auth with `app_metadata` set to `{"role":"admin"}`. From then on, invite the rest of the team from **Account**.

## Presets (`presets/`)

One JSON file per case type. Each one lists:
- the forms, with their edition dates
- the intake questions
- the client checklist; each item cites the USCIS instruction it comes from
- the cover letter template
- the timing rules

| Preset | Forms | Built from |
| --- | --- | --- |
| Asylum | I-589 (+ Supp. A/B) | I-589 Instructions 07/28/26 |
| EB-2 (PERM / NIW) | I-140 (+ I-485) | I-140 Instructions 06/07/24, USCIS I-140 checklist 11/06/2024 |
| I-360 (religious worker, SIJ, widow(er)) | I-360 (+ I-485) | I-360 Instructions 01/20/25, M-737 07/15/22 |
| I-485 | I-485, Supp. J, I-864, I-693, I-765, I-131 | I-485 Instructions 09/18/26 |
| Green card (family) | I-130, I-130A, I-485, I-864, I-693, I-765, I-131 | I-130 Instructions 04/01/24, USCIS I-130 checklist, I-485 Instructions |
| FOIA | USCIS FIRST / G-639 | **No instructions on file: verify** |
| I-751 | I-751 | I-751 Instructions 04/01/24 |
| I-765 | I-765 | **No instructions on file: verify** |
| T-Visa | I-914, Supp. A, Supp. B, I-192 | I-914 and Supp. B Instructions 09/14/26 |
| VAWA | I-360 (+ I-485) | I-360 Instructions 01/20/25 |
| I-539 | I-539, I-539A | I-539 Instructions 08/28/24 |

The text of each instruction PDF is in `reference/uscis-text/`, so presets can be checked against the source. The attorney should review every preset before it is used on a real case.

**Timing rules** are checked before assembly and shown as deadlines:
- I-751: 90-day joint filing window
- Asylum: one-year filing deadline; 150-day EAD clock
- EB-2 PERM: 180-day labor certification validity
- VAWA and widow(er): 2-year limits
- I-539: late filing
- I-485: a reminder to check the Visa Bulletin

**Never auto-filled:** G-28, attorney, preparer, interpreter and translator sections, and signatures. Code blocks them (`lib/forms.js`) even if a field map lists them. Some forms are completed by third parties: I-693 (civil surgeon), I-914 Supplement B, ETA-9089 Appendix A. These are flagged for staff to insert by hand.

## Filling the official USCIS PDFs

Until a blank form is added, the package prints one **staff data sheet** with every answer, to transcribe by hand. To fill a form automatically:

1. Download the blank form from uscis.gov and save it as `forms/i-130.pdf` (lower-case, hyphens).
2. List its fields: `npm run inspect-form -- forms/i-130.pdf`
3. Write `fieldmaps/i-130.json`, for example:

   ```json
   { "edition": "04/01/24", "fields": {
       "form1[0].#subform[0].Pt2Line4a_FamilyName[0]": "familyName",
       "form1[0].#subform[0].Pt2Line8_DateofBirth[0]": { "answer": "dob", "date": true }
   } }
   ```

Some USCIS PDFs are encrypted or XFA-based. If a form cannot be filled, the package falls back to the data sheet and the build notes say why. Test each form early.

## Layout

```
server.js              API: sign-in check, cases, files, assembly, automation endpoints
lib/repo.js            Supabase data layer and access rules
lib/presets.js         preset loading and conditions
lib/validate.js        readiness checks and USCIS timing rules
lib/deadlines.js       deadline dates from the timing rules
lib/assemble.js        cover letter, data sheet, exhibit index, tab pages, merge, bookmarks
lib/forms.js           official PDF filling with blocked sections
supabase/migrations/   database schema, security rules, storage, automation triggers
presets/               one JSON per case type (+ _common.json shared questions)
public/                web app (installable): login, client portal, staff dashboard, account
n8n/                   importable workflows
scripts/               setup, seed, n8n import, workflow builder, form inspector
config/firm.json       letterhead details (fill in the bracketed values)
reference/             extracted USCIS instruction text
```

## Before real client data

- Move to Supabase Cloud with a BAA, and make two-step verification mandatory for staff.
- Back up the database and storage nightly, then test a restore.
- Connect the staff digest and edition alerts.
- Have the attorney sign off on each preset.
