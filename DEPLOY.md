# Naylorade Stream Guide — Deployment Guide

## What you're deploying
- **Backend** (Python/Flask) → Railway
- **Frontend** (React/Vite) → Vercel
- Total cost: $0 at your scale

---

## Step 1 — Push to GitHub

You need both folders in GitHub. Easiest approach: one repo with two folders.

1. Go to github.com → New repository → name it `naylorade`
2. On your machine, install Git if you don't have it: https://git-scm.com
3. In your terminal:

```bash
cd /path/to/naylorade
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/YOUR_USERNAME/naylorade.git
git push -u origin main
```

---

## Step 2 — Deploy Backend to Railway

1. Go to **railway.app** → sign up with GitHub
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `naylorade` repo
4. Railway will detect the `backend/` folder — set the **Root Directory** to `backend`
5. It will auto-detect Python and install from `requirements.txt`
6. Once deployed, Railway gives you a URL like:
   `https://naylorade-backend-production.up.railway.app`
7. **Copy that URL** — you need it for the frontend

✅ Test it: visit `YOUR_RAILWAY_URL/api/health` — you should see `{"status": "ok"}`

---

## Step 3 — Deploy Frontend to Vercel

1. Go to **vercel.com** → sign up with GitHub
2. Click **New Project** → Import your `naylorade` repo
3. Set **Root Directory** to `frontend`
4. Under **Environment Variables**, add:
   - Key: `VITE_API_URL`
   - Value: `https://YOUR_RAILWAY_URL` (the URL from Step 2, no trailing slash)
5. Click **Deploy**
6. Vercel gives you a URL like: `https://naylorade.vercel.app`

**That's the link you send to your friends.**

---

## Step 4 — Share with friends

Send them your Vercel URL. When they open it:
1. They click **Connect ESPN**
2. They enter their own league ID, espn_s2, and SWID cookies
3. Their roster loads and they see only their games

### How to find ESPN cookies (for you and your friends):
1. Log into ESPN Fantasy on Chrome
2. Press F12 → Application tab → Cookies → click `fantasy.espn.com`
3. Find `espn_s2` — copy the Value
4. Find `SWID` — copy the Value (include the curly braces)
5. Your League ID is in the URL when you view your league:
   `fantasy.espn.com/baseball/league?leagueId=XXXXXX`

---

## Updating the app later

Push changes to GitHub — Railway and Vercel both auto-redeploy on every push.

```bash
git add .
git commit -m "update"
git push
```

---

## Troubleshooting

**"Invalid ESPN credentials"** — cookies expire. Grab fresh ones from the browser.

**Games not showing** — MLB API can be slow on opening day / heavy traffic. Refresh in 30s.

**CORS error in browser** — make sure `VITE_API_URL` in Vercel matches your Railway URL exactly (no trailing slash, correct https://).
