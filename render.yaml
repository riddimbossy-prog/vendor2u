# Vendor2U

A marketplace connecting customers with African & multicultural event vendors across the US. One Node.js app serves both the website and the API, backed by a real SQLite database so your vendors and quote requests are saved permanently.

## What works right now

- **Homepage** with search by service, culture, or location
- **Vendor listings** loaded live from the database
- **Vendor profiles** with full details and a "Request a Quote" form
- **Quote requests** that save to the database
- **"Become a Vendor" form** that adds new (unverified) listings to the database
- **AI matching engine** (`POST /api/match`) that ranks vendors by fit

## Files (what each one does)

- `public/index.html` — the whole website (what visitors see)
- `server.js` — the backend: serves the site and answers API requests
- `db.js` — sets up the database and adds 6 starter vendors the first time it runs
- `package.json` — the list of tools the app needs
- `render.yaml` — tells Render.com how to host it with a saved database

You do **not** need to edit any of these to get it online.

---

## Part 1: Run it on your own computer (optional, ~5 min)

You need Node.js installed (get it from https://nodejs.org — pick the "LTS" version).

1. Open a terminal in this folder.
2. Type `npm install` and press Enter. Wait for it to finish.
3. Type `npm start` and press Enter.
4. Open your browser to **http://localhost:5000**

You'll see your site, fully working. To stop it, press `Ctrl + C` in the terminal.

The first run creates a file called `vendor2u.db` — that's your database. Don't delete it unless you want to start fresh.

---

## Part 2: Put it live on the internet (~15 min, free)

We'll use **Render.com** because it's free to start and handles the saved database well.

### Step 1 — Put your code on GitHub

1. Create a free account at https://github.com
2. Click the **+** (top right) → **New repository**
3. Name it `vendor2u`, keep it **Public**, click **Create repository**
4. On the next page, click **uploading an existing file**
5. Drag in **all the files from this folder EXCEPT the `node_modules` folder** (don't upload node_modules — Render rebuilds it). Include `public/`, `server.js`, `db.js`, `package.json`, `package-lock.json`, `render.yaml`, `.gitignore`, and `README.md`.
6. Click **Commit changes**

### Step 2 — Deploy on Render

1. Create a free account at https://render.com (choose "Sign up with GitHub" — easiest)
2. On your dashboard click **New +** → **Blueprint**
3. Connect your GitHub and pick your `vendor2u` repository
4. Render reads `render.yaml` automatically and sets everything up. Click **Apply**.
5. Wait a few minutes while it builds. When it's done you'll get a live URL like `https://vendor2u.onrender.com`

That's it — your site is live and its data is saved on a persistent disk.

> **Note on the free plan:** free Render services "go to sleep" after 15 minutes of no visitors, so the first visit after a quiet period takes ~30 seconds to wake up. That's normal. Upgrading to their cheapest paid plan removes the sleep.

### Step 3 — Making changes later

Whenever you change a file, upload the new version to GitHub (same as Step 1.4–1.6). Render automatically rebuilds and redeploys within a couple of minutes. No terminal needed.

---

## The API (for reference)

- `GET /api/health` — is the server up?
- `GET /api/vendors` — all vendors; filters: `?q=`, `?category=`, `?state=`, `?minRating=`
- `GET /api/vendors/:id` — one vendor
- `POST /api/vendors` — add a vendor (needs `name` + `category`)
- `POST /api/match` — AI matching; send `service`, `location`, `cultural`, `budget`
- `POST /api/bookings` — save a quote request (needs `vendorId`)
- `GET /api/bookings/vendor/:vendorId` — a vendor's quote requests

---

## Sensible next steps (when you're ready)

1. **Real accounts** — so vendors can log in and manage their own listing
2. **A vendor dashboard** — so vendors see their quote requests in the browser (the data is already being saved; it just needs a page)
3. **Email notifications** — email the vendor when a quote comes in
4. **Photo uploads** — let vendors upload real photos instead of placeholders
5. **Payments** — Stripe, once bookings are firm

Tackle them one at a time. Each is a self-contained addition to what you already have.
