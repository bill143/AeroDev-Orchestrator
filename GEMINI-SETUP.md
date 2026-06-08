# Wiring the live Gemini model — setup guide

You now have two files:

- `AIPlayground.tsx` — the app (calls your backend, never holds the key)
- `api/chat.ts` — the backend route that holds the key and talks to Gemini

The app already works in **demo mode** (canned responses) with no setup. To switch
on **live Gemini answers**, do the three steps below. You will never paste the key
into the code or into a chat — it goes into a secret box in your host's dashboard.

---

## STEP 1 — Get a free Gemini API key (≈2 min)

1. Open **Google Chrome** and go to: `https://aistudio.google.com/apikey`
2. Sign in with your Google account if asked.
3. Click the button labeled **"Create API key"**.
4. When the key appears, click **"Copy"**. (It's a long string starting with `AIza…`.)
5. Paste it somewhere private for a moment (e.g. a new Notepad window) — you'll
   need it in Step 3. **Do not put it in any code file.**

---

## STEP 2 — Put both files in your project

Place them so the structure looks like this (the `api` folder must sit at the
project root, next to your app code):

```
your-project/
├─ api/
│  └─ chat.ts
└─ (your existing app files, including AIPlayground.tsx)
```

In **File Explorer (Windows)**: open your project folder, create a new folder
named exactly `api`, and move `chat.ts` into it.

---

## STEP 3 — Add the key as a secret on your host (Vercel)

1. Open **Google Chrome** and go to: `https://vercel.com`
2. Click **"Log In"** (top right), sign in (using GitHub is easiest).
3. Open your project (or click **"Add New…" → "Project"** to import it first).
4. In the project, click the **"Settings"** tab (top menu).
5. In the left sidebar, click **"Environment Variables"**.
6. In the **"Key"** (or **"Name"**) box, type exactly:
   ```
   GEMINI_API_KEY
   ```
7. In the **"Value"** box, paste the key you copied in Step 1.
8. Leave the environment set to **"All Environments"** (the default).
9. Click **"Save"**.

(Optional) To pick a specific Gemini model, repeat steps 6–9 with
Key = `GEMINI_MODEL` and Value = `gemini-2.5-flash` (this is already the default,
so you can skip it).

---

## STEP 4 — Turn off demo fallback and deploy

1. Open `AIPlayground.tsx` in **VS Code**.
2. Press **Ctrl + F**, type `USE_MOCK_FALLBACK`, press **Enter**.
3. Change the line from:
   ```
   const USE_MOCK_FALLBACK = true;
   ```
   to:
   ```
   const USE_MOCK_FALLBACK = false;
   ```
   (Leaving it `true` is also fine — it only matters if the backend is unreachable.)
4. Save the file (**Ctrl + S**).
5. Redeploy: in Vercel, open the **"Deployments"** tab and click
   **"Redeploy"** on the latest deployment (or just push your change to GitHub and
   Vercel rebuilds automatically).

---

## How to confirm it's live

Open your deployed app, go to **Direct** mode, and send a message.
- If you see a real, varied answer → Gemini is live. ✅
- If you see the line "*Demo mode — the live model responds once /api/chat is
  deployed.*" → the backend wasn't reached. Re-check Step 3 (the key name must be
  exactly `GEMINI_API_KEY`) and that the `api/chat.ts` file is at the project root.

---

## Notes

- **The key stays on the server.** The browser only ever talks to `/api/chat` on
  your own domain; the Gemini key never leaves Vercel's servers.
- **Free tier limits:** Gemini Flash free tier allows roughly 1,500 requests/day.
  Fine for a demo or light use. Heavy traffic will need a paid Google plan.
- **Image / Video capability buttons** currently return a *text description* from
  Gemini, not a generated image or video. True image/video generation is a separate
  provider integration we can add later.
- **All four modes** (Direct, Battle, Side by Side, Agent) now route through this
  same live backend automatically — no extra wiring needed.
