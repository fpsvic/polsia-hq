# Polsia — Autonomous AI Company OS

## Run locally

```bash
npm install
npm start
# → http://localhost:3000
# → Demo: jane@polsia.ai / demo1234
```

## Deploy to Render (free)

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
# Create a repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/polsia.git
git push -u origin main
```

### 2. Deploy on Render
1. Go to **render.com** → sign up / log in
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repo
4. Render auto-detects Node.js. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
5. Under **Environment Variables**, add:
   - `JWT_SECRET` → any long random string (e.g. run `openssl rand -hex 32`)
6. Click **"Create Web Service"**
7. Your app is live at `https://polsia.onrender.com` (or similar)

> **Note:** On Render's free tier, the service sleeps after 15 minutes of inactivity and takes ~30s to wake up. Upgrade to the $7/mo Starter plan for always-on.

## API

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| POST | /auth/login | — | Login, returns JWT |
| POST | /auth/register | — | Register new user |
| GET | /auth/me | ✓ | Verify token |
| GET | /api/kpis | ✓ | Dashboard KPIs |
| GET | /api/agents | ✓ | Agent statuses |
| PATCH | /api/agents/:id | ✓ | Update agent |
| GET | /api/tasks | ✓ | Task board |
| POST | /api/tasks | ✓ | Create task |
| PATCH | /api/tasks/:id | ✓ | Advance task status |
| GET | /api/activity | ✓ | Activity feed |
| GET | /api/revenue | ✓ | 30-day revenue chart |

## Stack
- **Frontend:** Vanilla HTML/CSS/JS
- **Backend:** Node.js + Express
- **Database:** SQLite via sql.js (persisted as JSON)
- **Auth:** bcryptjs + JWT (7-day tokens)
