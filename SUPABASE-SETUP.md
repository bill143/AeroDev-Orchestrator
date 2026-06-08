# Auth + Persistence setup guide (Supabase + Google sign-in)

This turns on **login** and makes your **projects, pins, and folder assignments
survive a refresh** by saving them to a free Supabase database.

You have four new files:
- `lib/supabase.ts` — connects the app to your database (uses public keys)
- `lib/auth.ts` — Google sign-in / sign-out
- `lib/data.ts` — saves/loads your projects & items
- `supabase-schema.sql` — the database tables (you paste this in once)

Until you finish the steps below, the app keeps working in **demo mode** (no login,
seed data) — so nothing breaks while you set this up.

---

## STEP 1 — Create a free Supabase project (≈3 min)

1. Open **Google Chrome** → go to `https://supabase.com`
2. Click **"Start your project"** → sign in (GitHub is easiest).
3. Click **"New project"**.
4. Fill in: **Name** = `arena`, **Database Password** = click **"Generate a password"**
   then **"Copy"** it and save it in Notepad (you may need it later).
5. Pick the **Region** closest to you. Click **"Create new project"**.
6. Wait ~2 minutes for it to finish setting up.

---

## STEP 2 — Create the database tables (≈1 min)

1. In your Supabase project, click **"SQL Editor"** in the left sidebar.
2. Click **"New query"**.
3. Open `supabase-schema.sql` (in **VS Code** or **Notepad**), select all
   (**Ctrl + A**), copy (**Ctrl + C**).
4. Paste (**Ctrl + V**) into the Supabase query box.
5. Click **"Run"** (bottom right). You should see "Success. No rows returned."

---

## STEP 3 — Turn on Google sign-in (≈3 min)

1. In Supabase, left sidebar → click **"Authentication"**.
2. Click **"Sign In / Providers"** (or **"Providers"**).
3. Find **"Google"** in the list and click it. Toggle it **ON** (**"Enable"**).
4. It asks for a **Client ID** and **Client Secret** from Google. To get them:
   - Open a new tab → `https://console.cloud.google.com/apis/credentials`
   - Sign in. At the top, create or select any project.
   - Click **"+ Create Credentials"** → **"OAuth client ID"**.
     (If asked to "Configure consent screen" first: choose **External**, fill the
     app name and your email, **Save and Continue** through the steps.)
   - **Application type** → choose **"Web application"**.
   - Under **"Authorized redirect URIs"**, click **"Add URI"** and paste the
     **Callback URL** shown on the Supabase Google page (it looks like
     `https://YOUR-PROJECT.supabase.co/auth/v1/callback`).
   - Click **"Create"**. Google shows a **Client ID** and **Client Secret** — copy both.
5. Back in Supabase, paste the **Client ID** and **Client Secret** into the Google
   provider fields. Click **"Save"**.

---

## STEP 4 — Add the connection values to your app host (Vercel)

You need two **public** values from Supabase (these are safe to expose):

1. In Supabase, left sidebar → **"Project Settings"** → **"API"** (or **"Data API"**).
2. Copy the **"Project URL"** (looks like `https://YOUR-PROJECT.supabase.co`).
3. Copy the **"anon" / "publishable" key** (a long string under "Project API keys").

Now add them in Vercel:

4. Open `https://vercel.com` → your project → **"Settings"** → **"Environment Variables"**.
5. Add the first variable:
   - Name: `NEXT_PUBLIC_SUPABASE_URL`
   - Value: the Project URL from step 2
   - Click **"Save"**.
6. Add the second variable:
   - Name: `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - Value: the anon/publishable key from step 3
   - Click **"Save"**.

(The `NEXT_PUBLIC_` prefix is required — it's what lets the browser read these.)

---

## STEP 5 — Tell Supabase your live web address

So Google sends users back to the right place after login:

1. In Supabase → **"Authentication"** → **"URL Configuration"**.
2. Set **"Site URL"** to your deployed address (e.g. `https://your-app.vercel.app`).
3. Under **"Redirect URLs"**, click **"Add URL"** and add the same address.
4. Click **"Save"**.

---

## STEP 6 — Install the library and redeploy

1. The app needs one package: `@supabase/supabase-js`.
   - In **VS Code**, open the terminal (**Ctrl + `**, the key above Tab) and run:
     ```
     npm install @supabase/supabase-js
     ```
2. Make sure the four files are in place:
   ```
   your-project/
   ├─ lib/
   │  ├─ supabase.ts
   │  ├─ auth.ts
   │  └─ data.ts
   └─ AIPlayground.tsx
   ```
3. Redeploy in Vercel (**"Deployments"** tab → **"Redeploy"**), or push to GitHub.

---

## How to confirm it works

1. Open your deployed app. You should now see a **"Continue with Google"** sign-in
   screen instead of going straight in.
2. Sign in. You land in the app; the bottom-left account button shows your name.
3. Create a project, pin it, move an item into it.
4. **Refresh the page.** Everything you did is still there. ✅
5. Click your name (bottom-left) to **sign out**.

If you still go straight into the app with seed data (no sign-in screen), the two
`NEXT_PUBLIC_SUPABASE_*` variables aren't set correctly — recheck Step 4 (names must
match exactly) and redeploy.

---

## What persists now (v1)

- ✅ Projects (create, rename, recolor, delete)
- ✅ Pinned / unpinned state
- ✅ Moving an item into a project (or to ungrouped)
- ⏳ **Conversation history** is the next step — chats themselves aren't saved yet.
  That's a larger data model and the planned v2 of persistence.

## Security notes

- Each user can only ever see and change **their own** rows — enforced in the
  database by Row-Level Security (the policies in `supabase-schema.sql`).
- The keys in `lib/supabase.ts` are the **public** keys, safe for the browser.
  Never put the Supabase **service_role** key in the app — it bypasses security.
- Passwords are never handled by Arena; Google owns the login.
