# Arena — Multi-Model AI Platform

A web app for chatting with, comparing, and orchestrating AI models. Modes: Direct,
Side by Side, Battle, and Agent.

## Stack
- **Next.js 14** (App Router) + **React 18** + **TypeScript**
- **Tailwind CSS**
- **Gemini** for model responses (via a server-side route that holds the key)
- **Supabase** for Google sign-in + persistence

## Run locally
1. Install dependencies:
   ```
   npm install
   ```
2. Copy `.env.example` to `.env.local` and fill in your keys.
3. Start the dev server:
   ```
   npm run dev
   ```
4. Open http://localhost:3000

## Environment variables
See `.env.example`. Required:
- `GEMINI_API_KEY` — server-only, from https://aistudio.google.com/apikey
- `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` — from your Supabase
  project's API settings

Without these, the app still runs in **demo mode** (mock responses, no login).

## Database setup
Run `supabase-schema.sql` once in the Supabase SQL Editor. See `SUPABASE-SETUP.md`.

## Deploy
Push to GitHub and import the repo at https://vercel.com. Set the same environment
variables in Vercel → Settings → Environment Variables, then deploy.

## Project structure
```
app/
  layout.tsx          root layout
  page.tsx            renders the Arena workspace
  globals.css         Tailwind + base styles
  api/chat/route.ts   server-side Gemini proxy (holds the API key)
components/
  AIPlayground.tsx    the entire Arena UI (all four modes)
lib/
  supabase.ts         browser Supabase client
  auth.ts             Google sign-in / sign-out
  data.ts             load/save projects & items
supabase-schema.sql   database tables + row-level security
```
