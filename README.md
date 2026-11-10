# Margyn Express backend

A standalone **Node.js, Express 5 and MongoDB** application at `C:\Users\sachi\OneDrive\Desktop\easyryt-github\margyn\backend`, alongside `admin-panel` and `margyn-2026`. This folder can be copied and deployed independently of the frontend. Its entry point is `src/server.mjs`.

```text
backend/
  src/
    server.mjs             Process startup and graceful shutdown
    app.mjs                Express configuration and route registration
    config.mjs             Backend environment loading
    routes/                Authentication, products, admin, carts and orders
    middleware/            Sessions, authorization, origins and API errors
    services/              MongoDB persistence and business logic
    pricing.mjs            Authoritative pricing calculations
    types.d.ts             Backend response type documentation
  scripts/                 Admin setup, migration and service checks
  tests/                   Isolated domain and real HTTP integration tests
  .env.example             Server configuration placeholders
  package.json
```

## Start independently

Requires Node.js 22.13+ and MongoDB Atlas or another replica set. Transactions are required for order creation and stock reservation.

```powershell
npm install
# For a new checkout only:
# Copy-Item .env.example .env
# Fill in your server credentials.
npm run dev
```

This project already has its configured `.env`. Run it in its own terminal; it does not launch the frontend. The default API URL is http://127.0.0.1:4000. `npm start` runs the API without the file watcher. There is no build step and no dependency on Next.js.

The backend loads `.env` relative to this folder regardless of the launching directory. The frontend runs independently from the sibling `margyn-2026` project on port 3000. Existing process environment variables take precedence. Local development defaults to `127.0.0.1:4000`. Production defaults to `0.0.0.0` when `HOST` is unset.

On Render, `RENDER=true` automatically selects `0.0.0.0`, even if an old local `HOST=127.0.0.1` setting is present. The server uses Render's `PORT` value, falling back to `10000` if it is absent. This satisfies [Render's port-binding requirement](https://render.com/docs/web-services#port-binding). Use build command `npm install`, start command `npm start`, and health check path `/api/health`. Push the updated backend and redeploy; no manual host override is required on Render.

For the deployed storefront, set this variable in the **Render backend service → Environment** and save/redeploy:

```text
FRONTEND_ORIGIN=http://localhost:3000,https://margyn-2026-inky.vercel.app
```

Use the frontend origin without `/login` or a trailing slash. The comma-separated value preserves localhost Postman/development requests and permits the deployed storefront. Updating `.env.example` documents the setting; the deployed service must receive it in Render's environment. The Vercel API rewrite forwards the browser's Origin header to this backend.

## Port already in use

`EADDRINUSE` means another process is already listening on the configured port. Keep only one backend terminal running. Stop the earlier backend with Ctrl+C, then run `npm run dev` in the terminal you want to use. The API prints its ready message only after it has successfully bound the port.

Check `http://127.0.0.1:4000/api/health`; a running API returns `{"service":"margyn-api","status":"ok"}`. To inspect the port owner in PowerShell, use `Get-NetTCPConnection -LocalPort 4000 -State Listen | Select-Object OwningProcess`, then inspect that process before stopping it.

## Configuration

| Variable                                                               | Purpose                                                                 |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `HOST`, `PORT`                                                         | Local default `127.0.0.1:4000`; Render uses `0.0.0.0` and its assigned `PORT` |
| `FRONTEND_ORIGIN`                                                      | Allowed browser origin(s), comma separated, no trailing slash           |
| `MONGODB_URI`, `MONGODB_DB`                                            | Atlas credentials and database; existing data uses `margyn_marketplace` |
| `MONGODB_DNS_SERVERS`                                                  | Optional comma-separated DNS fallback for SRV resolution                |
| `IMAGEKIT_URL_ENDPOINT`                                                | Allowed product media URL prefix                                        |
| `IMAGEKIT_PRIVATE_KEY`                                                 | Server-side ImageKit upload authentication                              |
| `OTP_PROVIDER`                                                         | `development` locally, explicit `test` for temporary OTP responses, or `twilio` for live SMS |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID` | Twilio Verify service credentials                                       |
| `SHIPPING_FLAT_RATE`, `FREE_SHIPPING_ABOVE`                            | Shipping amounts in rupees; zero threshold disables free shipping       |
| `TRUST_PROXY`                                                          | Enable only behind a trusted proxy replacing forwarded headers          |
| `LEGACY_DATA_DIR`                                                      | Optional path to the original SQLite backup, used only by migration     |

Private credentials belong only in `.env` or your hosting platform’s server environment. The public ImageKit key is not needed for server-side uploads. Production session cookies require HTTPS. Configure a six-digit Twilio Verify service for live SMS. Production never returns development codes.

## API routes

All endpoints are prefixed with `/api`. Mutation endpoints require an `Origin` matching `FRONTEND_ORIGIN`. JSON mutations require `Content-Type: application/json`. Login and cart cookies are HttpOnly; browser requests must include credentials when calling the API directly. The supplied frontend uses a same-origin proxy.

| Endpoint                          | Access and behavior                                         |
| --------------------------------- | ----------------------------------------------------------- |
| `GET /health`                     | MongoDB readiness and service identity                      |
| `POST /auth/request-otp`          | `{phone}`; expiry, resend cooldown and rate limits          |
| `POST /auth/verify-otp`           | `{challengeId,code}`; creates session and merges guest cart |
| `POST /auth/logout`               | Revokes session and clears cookies                          |
| `GET /auth/me`                    | Current user or null                                        |
| `GET /products`                   | Published catalog                                           |
| `GET /products/:id`               | Published product details                                   |
| `GET /media/:id`                  | ImageKit redirect or migrated legacy image                  |
| `GET, POST, PATCH /cart`          | Cart quote, item updates, saved items and coupons           |
| `GET /orders/mine`                | Signed-in customer’s own orders                             |
| `GET /orders`                     | Own orders; admins can see all requests                     |
| `GET /orders/:id`                 | Order owner or administrator only                           |
| `POST /orders`                    | Transactional, idempotent unpaid order request              |
| `GET, POST /admin/products`       | Admin catalog and creation                                  |
| `PUT, DELETE /admin/products/:id` | Admin update and deletion                                   |
| `POST /admin/upload`              | Admin multipart upload, field `file`                        |
| `GET /admin/users`                | Admin account list                                          |
| `PATCH /admin/orders/:id`         | Admin order status changes                                  |
| `GET, POST /admin/coupons`        | Admin coupon configuration                                  |

Uploads accept one JPG, PNG or WebP file up to 5 MB and validate its signature before sending it to ImageKit. The product editor supports eight gallery images. MongoDB stores image metadata; ImageKit stores new image files.

## AI plans, subscriptions and test checkout

Use the separate **admin-panel** app at **http://localhost:3001**, then choose **Tokens & subscriptions**. Each plan has a name, price in rupees, duration, up to 12 offer lines, an internal token allowance and a **Show this plan to users** switch. Saved visible plans automatically appear under **AI plans** in the customer workspace at `/tools/subscription`; no per-user assignment is needed to list a plan. Existing plans without prices remain visible with **Pricing coming soon** until an administrator sets a price. A price of zero creates a free plan; the same free plan can be claimed only once per validity period.

Customers see plan names, prices, included offers, validity and AI availability. Their subscription, catalog and purchase API responses do not expose provider-token allowances, provider-token usage counters or credentials. Internal provider usage is still metered and enforced for Image Generator and Listing Tool. Only admin responses include those counts. Production starting AI token allowances default to zero; changing the starting allowance affects token accounts first initialized afterward, not accounts already created.

A paid plan uses **Razorpay test checkout only**. `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` belong in this backend's `.env`; live-mode keys are rejected. The browser receives only the public test key and the server-created order for its own purchase. Plan prices and entitlements come from MongoDB, never from submitted browser amounts. All prices are stored as integer paise in INR. Plans are one-time purchases, without automatic renewal; activation starts a new validity period and replaces the current AI plan.

The backend verifies the checkout signature using its stored order ID, fetches the payment from Razorpay, and checks the order, amount, currency and captured status before granting access. Pending, failed, forged or wrong-owner payments do not grant AI access. Duplicate callbacks and webhook deliveries never reset an already-activated allowance. The purchase stores a snapshot of the price, offers and internal allowance so later plan edits do not change what was purchased. If an AI call is running, captured payments remain paid with activation pending until **Activate AI** is selected. An account awaiting an internal usage review must be reviewed by an administrator before starting a new payment.

After verifying the order, currency and exact amount, the backend captures an authorized test payment when needed; dashboard auto-capture is also supported. Access is granted only after capture succeeds. The customer's **Check payment** action recovers a successful payment if the browser callback was interrupted. For asynchronous confirmation, configure an optional, separate `RAZORPAY_WEBHOOK_SECRET` and subscribe to `payment.captured` / `order.paid` at `POST /api/subscription/payments/razorpay/webhook`. This route validates the raw-body signature before parsing or changing records and does not use browser origin/session authentication. Use a publicly reachable HTTPS endpoint when configuring Razorpay webhooks; localhost checkout can use the verified browser callback and Check payment.

Customer endpoints require a signed-in session:

- `GET /api/subscription`: own AI plan, validity, offers and access status, without internal usage fields.
- `GET /api/subscription/plans`: visible plan catalog and test-payment availability.
- `GET /api/subscription/purchases`: own latest purchases.
- `POST /api/subscription/purchases`: `{planId,idempotencyKey}` creates a checkout; retries reuse the recorded purchase.
- `GET /api/subscription/purchases/:id/checkout`: resume an owned pending checkout.
- `POST /api/subscription/verify-payment`: `{purchaseId,razorpay_order_id,razorpay_payment_id,razorpay_signature}` verifies capture and activates the plan.
- `POST /api/subscription/purchases/:id/refresh`: JSON `{}` checks payment or finishes activation.

Admin-only `GET /api/admin/subscriptions` includes accounts, settings and test-purchase records. `PUT /api/admin/subscription-settings` accepts `{defaultTokenLimit,plans:[{id,name,tokenLimit,durationDays,pricePaise,offers,published}]}`. `pricePaise:null` leaves pricing unset. `PUT /api/admin/users/:id/subscription` retains manual assignment, expiry, pausing and explicit new-period resets. Editing or removing catalog plans preserves existing assigned subscriptions and purchase snapshots. The admin OTP endpoints remain `/api/admin/auth/request-otp` and `/verify-otp`; production deployments configure the admin site's `ADMIN_ORIGIN` separately from the storefront.

`token_accounts` and `token_events` retain internal subscriptions, actual provider accounting and administrator audits without prompts, images or credentials. `ai_plan_purchases` stores purchase snapshots and unique order/payment references, and `ai_free_plan_claims` prevents repeated free-period claims. AI calls for the same account are serialized through database leases. Actual usage arrives after a provider call, so one running call may cross the remaining internal allowance; further calls stop once it is reached. Interrupted calls or missing usage create a review hold rather than an invented count. Renewing a period does not clear that hold.

Integration references: [Razorpay Standard Checkout](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/), [Orders API](https://razorpay.com/docs/api/orders/create/), and [webhook validation](https://razorpay.com/docs/webhooks/validate-test/).

Run `node --test tests/plan-payments.test.mjs tests/subscriptions.test.mjs tests/image-generator-http.test.mjs tests/listing-tool-http.test.mjs` for isolated payment, privacy, metering and authorization checks. Test fixtures replace payment and AI keys and mock all provider calls. They never use the configured Razorpay account or charge money.

## Data and authorization

The API reuses a MongoDB connection pool. Unique indexes protect SKUs, phone numbers and order idempotency keys. TTL indexes remove expired OTPs, sessions, rate windows and guest carts; authorization also checks expiry directly.

Administrator roles are checked in Express middleware on every admin endpoint. The only way to grant initial admin access is a server-side command:

```powershell
npm run admin:grant -- +919876543210
```

Replace the example with your phone number. Existing account roles and hashed session records are preserved. Old browser cookie names are read only for migration and are replaced with `margyn_session` and `margyn_cart`.

Cart and order prices are calculated on the server in paise. Submitted client prices are ignored. MongoDB transactions reserve stock, save the order and clear purchased cart lines together. Order retries use the customer’s idempotency key. Before shipping, cancellation restores reserved stock once. Orders remain unpaid because payment processing is not connected.

## Utilities and verification

```powershell
npm test
npm run services:check
npm run db:migrate
npm run brand:migrate
```

Tests start isolated local MongoDB replica sets and cover business rules plus actual Express HTTP requests, cookie migration, authorization, request limits, multipart uploads and checkout. They never use the live Atlas catalog. A test MongoDB binary may download on first use.

`db:migrate` imports the former SQLite backup with insert-only operations, preserving existing MongoDB records. The old backup filename is retained for compatibility; it is not used by the running API. `brand:migrate` changes only former platform vendor labels to Margyn and leaves account access, identifiers, prices and stock unchanged.

`node --env-file=.env scripts/check-upload.mjs` optionally verifies ImageKit with a newly generated blank pixel and then deletes that exact test image and its metadata. It does not read or upload local screenshots or documents.

For production, set NODE_ENV=production in the backend hosting environment and run npm start from this folder. The backend and frontend have independent processes and start commands.

## Announcement banner

`GET /api/site/announcement` returns the current visible announcement, or `null` when it is hidden. Administrators can read and update settings with `GET` and `PUT /api/admin/announcement`. The JSON fields are `enabled`, `message` (1–180 characters), `link` (optional local path or HTTPS URL), `backgroundColor`, `textColor` (six-digit hex colors), and `speed` (`slow`, `normal`, or `fast`). Updates are stored in the MongoDB `site_settings` collection and require the existing admin session and approved request origin. No deployment or environment change is needed.

## Promotional banner

The second homepage banner is configured independently through `GET /api/site/promo-banner` and admin-only `GET` / `PUT /api/admin/promo-banner`. Settings persist under `site_settings` with `_id: "promo-banner"`. Admins can edit visibility, label, title and highlighted line, description, up to three highlights, button labels and links, image and alt text, background/text/accent colors, and the image badge. Button links accept local paths or HTTPS URLs. Images must use the bundled Margyn artwork or the existing trusted ImageKit upload flow (`POST /api/admin/upload`). Hidden banners return `null` from the public endpoint.

## Customer profiles

Authenticated customers use `GET /api/profile` and `PATCH /api/profile` (`{name}`) to view their account and save a name. Verified login phone numbers and account roles cannot be changed through profile input. Each account can save up to ten shipping addresses using `POST /api/profile/addresses`, `PUT` / `DELETE /api/profile/addresses/:id`, and `PATCH /api/profile/addresses/:id/default` (JSON body `{}`). Address bodies use the checkout address fields plus `label` and `isDefault`. The server always uses the authenticated session owner, validates addresses with the checkout rules, and applies address-book changes in a MongoDB transaction. Existing accounts need no migration.

## Address location suggestions

The backend uses `@countrystatecity/countries` (pinned in package-lock.json), a free, offline-capable dataset. No external location API, API key, or per-request billing is used. Public endpoints `GET /api/locations/states` and `GET /api/locations/cities?state=MP` return only Indian state names/codes and city names. City state codes are checked against the packaged India list. Reference data is cached independently of customer sessions; names, phone numbers and addresses are never sent to a location provider.

The profile and checkout forms offer state selection and optional city suggestions. Towns absent from the dataset can still be typed manually. These suggestions do not validate a PIN code, address deliverability, or a city/PIN match.

Location data: [CSC Database / @countrystatecity/countries](https://github.com/dr5hn/countrystatecity-npm/tree/main/packages/countries), available under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/). The package includes its original license and source notices. The UI and API responses provide attribution; this reference dataset remains separate from private customer and order data.

## Shipping Labels tool

Signed-in users can POST one multipart `file` PDF to `/api/tools/shipping-labels/stats`, `/process`, or `/summary`. These routes reuse the original shipping-labels-tool extraction, SKU grouping, PDF splitting, ZIP and summary helpers. The JavaScript helpers under `src/tools/shipping-labels` are compiled from the supplied TypeScript with type erasure and explicit ESM extensions only; `provenance.json` records the original source hashes. Output layouts, filenames and grouping rules are preserved.

The tool retains the original 1 GB file limit. Uploads use UUID-named temporary files, removed after each request. PDF processing runs in worker threads (one job per user, two per process), with cancellation and a five-minute processing deadline. The normal session/origin guards and a per-user rate limit apply before uploads. PDF contents and generated files are not stored in MongoDB, sent to ImageKit, or logged. No global public PDF endpoints are added. Upstream hosts/reverse proxies must permit the configured upload size and processing timeout.

## Image Generator

Authenticated endpoints live under `/api/tools/image-generator`: `GET /providers`, and multipart `POST /generate`, `/generate-charms`, `/generate-charm-pack`. They reuse the supplied image-generator project's provider adapter, prompts, identity/review checks, selected-view behavior, template compositing and quantity logic. TypeScript is compiled into standalone ES modules under `src/tools/image-generator`; `provenance.json` records source and template hashes. Run the backend from this folder so the original reference lookup can read `public/templates`.

Only the required original reference templates are included. Generated images and uploaded customer images are returned for the current request rather than saved in MongoDB or ImageKit. Provider credentials and model settings belong in the backend environment; existing provider settings were retained. Each image is limited to 10 MB, and authenticated requests have per-user concurrency/rate guards. Presets, manual per-view retries and the source app's generation/review behavior remain unchanged. Sharp uses patched version 0.35.5. Local background composition, enhancement, quantity tags and ZIP exports run in the browser.


## Database selection and fresh tool workspaces

All persistent marketplace, profile, Listing Tool and Inventory Admin data uses `MONGODB_URI` and `MONGODB_DB` from this backend’s `.env`. Listing and inventory have private collections for each account; neither creates a separate database per user. This also avoids Atlas database-name length limits. Aggregate joins and populated references remain scoped to the same account. The original standalone tool databases and unprefixed legacy collections are not loaded or copied. A new tool workspace returns empty lists and zero analytics until its owner saves data. Existing legacy databases are left intact.

`node --test tests/workspace-database.test.mjs` verifies configured database selection, fresh workspaces, native collection access, unique indexes, nested report joins, and account isolation.

## Listing Tool

The Listing Tool runs within the existing Express API on port 4000. No extra service on port 5000 or external listing database is required. The frontend is at `/tools/listing-tool` and its API namespace is `/api/tools/listing-tool`.

The original product, charm, design, and general-product routers, schemas, validation, import mapping, transactions, AI prompts, retries, and title rules are retained under `src/tools/listing-tool`. A session wrapper checks every listing API request. An AsyncLocalStorage model adapter binds original queries, lookups, indexes and transactions to account-specific `listing_<seller hash>_*` collections inside the database selected by `MONGODB_DB` on `MONGODB_URI`. Listings are private to that account and never use the marketplace products collection. Existing records in the standalone Listing Tool are not migrated automatically.

The original four Next AI handlers are compiled to JavaScript and use a small Response adapter. Their processing logic is preserved. AI keys and ImageKit credentials use the existing backend environment only. Optional `LISTING_AI_PROVIDER`, `LISTING_GEMINI_CONTENT_MODEL`, and `LISTING_OPENAI_CONTENT_MODEL` preserve Listing Tool defaults independently of the Image Generator. Generated phone designs are saved through the original design router in the active seller context.

The original Chrome extension download is bundled with the frontend. Native upload still requires the original local Chrome/Meesho setup. The compatibility endpoint `/api/meesho-upload` requires Margyn login for image preparation; resolution retains the original extension-ID and 256-bit per-image capability checks. Staging stays local under ignored `.local/margyn-listing-staging`. The extension's external Meesho actions are unchanged.

Regression checks: `node --test tests/listing-tool*.test.mjs`. These cover original validation/import tests, actual isolated MongoDB transactions and account isolation, all four AI handlers with mocked Gemini/OpenAI/ImageKit calls, native staging authorization, and source-body parity for 96 imported files plus three original download assets. No live AI calls are needed. Backend imports use SheetJS 0.20.3 from its [official distribution](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/), retaining the original workbook API while avoiding the obsolete npm 0.18.5 release. Original source projects are untouched.


## Inventory Admin integration

Inventory Admin uses the existing Express process on port 4000 at `/api/tools/inventory-admin`. It reuses the stock, purchasing, printing, barcode, packing, category, product, design and staff controllers from the standalone inventory backend. The original frontend and backend project folders are untouched. Source processing bodies are recorded in `src/tools/inventory-admin/provenance.json` and checked by a 61-file regression snapshot.

Every request first checks the Margyn HttpOnly session. A request-local Mongoose adapter binds all original models, aggregations, populates, indexes and transactions to account-specific `inventory_<seller hash>_*` collections inside the same `MONGODB_DB` database used by the marketplace. Each Margyn account owns a private inventory workspace and receives ADMIN capabilities inside that workspace; this does not grant marketplace administrator access. Owner audit records use a deterministic ObjectId derived from the Margyn UUID, with a generated, hashed internal password. Legacy staff records created in this workspace remain inventory-local; they do not create Margyn OTP identities or change marketplace permissions. Standalone data, staff logins and images are not migrated automatically.

Legacy proxy conventions remain supported, including `printing-jobs?kind=products`, `printing-jobs/:id?kind=designs`, `GET /barcodes` and `PATCH /inventory/threshold/:id`. Source response endpoint metadata is translated into the inventory API namespace. The database adapter removes a redundant `$setOnInsert.minThreshold` when the original RAW endpoint also supplies an explicit `$set.minThreshold`, avoiding MongoDB's conflicting-update error without changing stock calculations or source controllers.

Image uploads use the original validation/progress UI and server-side ImageKit transport, using existing backend environment credentials. Each seller's media lives in `/margyn/inventory/<seller hash>`; list, replace and delete verify that scope. Uploads retain the 10 MB per-file limit, while the source design editor keeps its 300 KB limit. No unrestricted ImageKit upload signatures or real session tokens are exposed to the browser. Media response shapes are preserved by the scoped SDK adapter, with quota errors returned through the inventory HTTP routes. The source frontend's media-only public key was copied to the backend when missing; the browser no longer needs ImageKit environment values.

Run `node --test tests/inventory-admin*.test.mjs` to check the original 15 unit cases, actual isolated MongoDB stock/printing/purchase/packing workflows, exact barcode retries, legacy proxy compatibility, account and media isolation, and source-body parity. ImageKit requests in tests are mocked. The unit-test loader uses disconnected models for the original model doubles; the HTTP tests exercise the real request-scoped models and transactions.

### AI images and storage limits

Admins set free-account internal AI tokens, AI output images and storage bytes in subscription settings, plus independent allowances on every plan. New installations default to 10 output images and 100 MB storage; AI tokens still default to zero until configured. The admin UI accepts storage in MB (1 MB = 1,048,576 bytes). Defaults initialize new accounts once; existing accounts keep their limits. Use Manage limits to edit a user, select a plan, or Copy free defaults. Starting a new period resets AI tokens and generated-image usage; storage usage is never reset. Plan purchases snapshot these benefits and reset the AI period only after activation.

Each returned AI output view counts as one image, including drafts requiring review. Product/charm analysis, provider retries and reviews use actual AI tokens but do not add image counts. Selected views are reserved before provider work; failed views release their reservation. A crashed worker conservatively retains the reserved count until an admin reviews or resets the period. Expired locks are released without refunding uncertain work.

Persistent inventory and listing-tool uploads share each user's ImageKit library and byte quota. All app upload, replacement and deletion paths use a MongoDB lease and an authoritative, paginated ImageKit size check before changes. Both the root folder and listing subfolder are enumerated because ImageKit path filtering is not recursive ([SDK reference](https://github.com/imagekit-developer/imagekit-nodejs/blob/master/src/resources/assets.ts)). Storage measures current saved originals, excluding temporary inputs, downloads, CDN derivatives and provider version history. Marketplace catalog assets are separate administrator-managed site content.

Deleting a library image frees bytes. A smaller replacement is allowed even when over quota; growing uploads require an active plan and enough space. Downgrading, expiry and renewal preserve files. Old design-library assets with saved file references and general-listing images referenced by saved products are included for accounting without granting deletion rights over old shared folders. Older orphaned files in shared provider folders cannot be attributed automatically.

Public plan and subscription responses include image/storage benefits and usage, while all provider-token counts remain admin-only. Storage usage is cached for display; opening/changing the library or POST /api/subscription/storage/refresh reconciles it. Missing provider size metadata blocks writes instead of assuming files are free. storage_accounts and storage_legacy_files hold byte usage/locks and references for older shared assets.

Run node --test tests/resource-allowances.test.mjs for quota, renewal, partial generation, concurrent-worker, account isolation and multi-page reconciliation checks.

## Temporary OTP-in-response login

Until SMS is configured, explicitly set OTP_PROVIDER=test in the Render backend environment and redeploy the updated backend. Keep NODE_ENV=production so session cookies remain Secure and HttpOnly. The API generates a fresh random six-digit code and returns it from POST /api/auth/request-otp (and the administrator equivalent):

```json
{
  "challengeId": "<challenge-id>",
  "phone": "+919876543210",
  "expiresAt": 1794355500000,
  "resendAfter": 60,
  "otp": "123456",
  "developmentCode": "123456"
}
```

The displayed code is illustrative, not fixed. Submit challengeId and the returned otp as code to POST /api/auth/verify-otp. The legacy developmentCode alias keeps existing clients compatible. The storefront/admin login forms display the returned code. Five-minute expiry, single-use verification, resend cooldown, attempt limits and administrator-role checks still apply. Only the code hash is stored. Turning test mode off also rejects outstanding test-mode challenges.

This mode does not prove phone ownership: anyone who can request a code can sign in as that phone number, including a known administrator number. It is for temporary testing. Switch OTP_PROVIDER to twilio and configure the Twilio credentials for real SMS login. Test mode is never selected automatically because SMS configuration is missing; development mode remains blocked in production, and Twilio responses contain no OTP.
