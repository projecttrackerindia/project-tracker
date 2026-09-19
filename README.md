# 🚀 ProjectFlow - Railway Deployment (Clean Start)

Deploy your ProjectFlow app to Railway in **3 simple steps**!

---

## 📦 What's Included

This is a **clean, minimal setup** with only essential files:

```
projectflow/
├── app.py              ✅ Your Flask application
├── requirements.txt    ✅ Python dependencies
├── Procfile           ✅ Railway start command
├── .gitignore         ✅ Git excludes
└── README.md          ✅ This file
```

**That's it!** No complex configs. Railway auto-detects everything.

---

## ⚡ Quick Deploy (3 Steps)

### Step 1: Push to GitLab (1 minute)

```bash
# Initialize git
git init

# Add all files
git add .

# Commit
git commit -m "Initial commit - ProjectFlow"

# Add your GitLab remote (replace with your URL)
git remote add origin https://gitlab.com/YOUR-USERNAME/projectflow.git

# Push
git push -u origin main
```

---

### Step 2: Deploy on Railway (2 minutes)

1. Go to **https://railway.app**
2. Sign up/Login (free - no credit card needed)
3. Click **"New Project"**
4. Select **"Deploy from GitLab repo"**
5. Authorize Railway to access GitLab
6. Choose your **projectflow** repository
7. Click **"Deploy Now"**

**That's it!** Railway automatically:
- ✅ Detects Python app
- ✅ Installs dependencies
- ✅ Starts with Gunicorn
- ✅ Provides HTTPS URL

---

### Step 3: Configure (30 seconds)

#### Add Persistent Storage
1. Railway Dashboard → Your Project
2. Settings → **Volumes**
3. Click **"+ New Volume"**
4. **Mount Path:** `/data`
5. **Size:** 1 GB
6. Click **"Add"**
7. **Redeploy**

#### Environment Variables (Optional - for email)
Railway Dashboard → **Variables** → Add:

```
EMAIL_ENABLED=true
SMTP_SERVER=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=your-email@gmail.com
SMTP_PASSWORD=your-gmail-app-password
FROM_EMAIL=notifications@yourcompany.com
```

#### Environment Variables (Optional - for default/native AI)
By default, each workspace must add its own Anthropic API key (Settings →
AI Assistant) to use AI features. To also offer a built-in default —
"Project Tracker AI" — that workspaces get for free up to a monthly cap,
set:

```
PLATFORM_AI_API_KEY=sk-ant-xxxxxxxxxxxxxxxx
```

This is **your own** Anthropic key, billed to you — not a per-workspace
key. Behavior:
- A workspace with its own key in Settings always uses that key, with no cap.
- A workspace without one automatically uses `PLATFORM_AI_API_KEY` instead,
  up to a monthly call limit set per plan (see `ai_calls_platform_month` in
  `app.py`'s `_DEFAULT_WORKSPACE_PLAN_USAGE_LIMITS` — defaults are 50/month
  on Starter, 200 on Team, 1000 on Business, effectively unlimited on
  Enterprise). Admins can raise a single workspace's cap via the existing
  `custom_limits_json` override the same way other plan limits are raised.
- If `PLATFORM_AI_API_KEY` is left unset, behavior is unchanged from today:
  workspaces without their own key get a "please add your API key" message.
- `/api/ai/chat` and `/api/ai/generate-docs` responses now include
  `ai_source` (`"own"` or `"platform"`) plus `ai_platform_calls_used` /
  `ai_platform_calls_limit`, so the frontend can show which key answered
  and how much of the free monthly quota is left. `GET /api/usage` also
  now reports `ai_calls_month` (total) and `ai_calls_platform_month`
  (platform-key calls only).

---

## 🎉 Done!

Your app is live at: **`https://your-project.railway.app`**

Test it:
```bash
curl https://your-project.railway.app/health
```

Response:
```json
{"status": "healthy", "service": "ProjectFlow", "version": "4.0"}
```

Access app:
```
https://your-project.railway.app/api/app
```

---

## 📁 File Breakdown

### `requirements.txt`
```
Flask==3.0.0
Flask-CORS==4.0.0
gunicorn==21.2.0
```
Simple! Just 3 dependencies. Railway installs these automatically.

### `Procfile`
```
web: gunicorn --bind 0.0.0.0:$PORT --workers 4 --threads 2 --timeout 120 app:app
```
Tells Railway how to start your app with Gunicorn (production WSGI server).

### `app.py`
Your Flask application with:
- ✅ DM removed from sidebar
- ✅ In-call chat removed
- ✅ Email notifications added
- ✅ Health check endpoint at `/health`

---

## 🔧 Railway Features

### Auto-Deploy
Push to GitLab → Railway automatically redeploys!

```bash
# Make changes
git add .
git commit -m "Update feature"
git push origin main

# Railway auto-deploys in ~2 minutes
```

### Monitoring
Railway Dashboard shows:
- CPU & Memory usage
- Request count
- Response times
- Error logs

### View Logs
```bash
# Install Railway CLI (optional)
npm install -g @railway/cli

# Login
railway login

# View logs
railway logs
```

Or view in Railway Dashboard → Deployments → Logs

---

## 🌐 Custom Domain (Optional)

1. Railway Dashboard → Settings → **Domains**
2. Click **"+ Custom Domain"**
3. Enter: `projectflow.yourcompany.com`
4. Add DNS record (CNAME):
   ```
   Name: projectflow
   Value: your-app.railway.app
   ```
5. Wait ~5 minutes for DNS
6. Done! ✅

---

## 💰 Pricing

**Free Tier:**
- $5 credit/month
- ~500 hours runtime
- Perfect for small teams
- No credit card required

**Your app will likely use:**
- Small team (1-10 users): **FREE** ✅
- Medium team (50 users): ~$5-10/month
- Large team (500 users): ~$20-50/month

---

## 🐛 Troubleshooting

### Build Failed
Check Railway logs for errors:
- Railway Dashboard → Deployments → Build Logs

Common fixes:
- Verify `requirements.txt` has correct packages
- Check `Procfile` syntax
- Ensure `app.py` is in repository root

### App Shows 502 Error
**Fix:** Add persistent volume at `/data`
1. Settings → Volumes
2. Mount: `/data`
3. Redeploy

### Database Resets on Deploy
**Fix:** Volume not configured
- Add volume at `/data` (see Step 3 above)

### Email Not Working
**Fix:** Check environment variables
- Use Gmail App Password (not regular password)
- Verify all SMTP variables are set
- Check logs: `railway logs`

---

## 📊 Health Check

Railway monitors your app health via the `/health` endpoint.

**Test:**
```bash
curl https://your-app.railway.app/health
```

**Response:**
```json
{
  "status": "healthy",
  "service": "ProjectFlow",
  "version": "4.0",
  "timestamp": "2026-03-18T09:52:00.000Z"
}
```

If health check fails, Railway auto-restarts your app.

---

## 🔄 Update & Redeploy

```bash
# Make changes to app.py
nano app.py

# Commit
git add .
git commit -m "Add new feature"

# Push
git push origin main

# Railway auto-deploys! 🚀
```

---

## ✅ Post-Deployment Checklist

After successful deployment:

- [ ] App accessible at Railway URL
- [ ] Health endpoint returns OK: `/health`
- [ ] Login works (test with demo account)
- [ ] Database persists (volume configured)
- [ ] Email notifications work (if configured)
- [ ] Test creating projects & tasks
- [ ] Invite team members
- [ ] Set custom domain (optional)

---

## 💡 Pro Tips

1. **Keep it simple** - These 3 files are all you need
2. **Let Railway auto-detect** - No manual configs needed
3. **Use volumes** - Essential for database persistence
4. **Monitor logs** - Check for errors regularly
5. **Auto-deploy** - Push to GitLab = instant deploy

---

## 📞 Support

**Railway:**
- Docs: https://docs.railway.app
- Discord: https://discord.gg/railway
- Status: https://status.railway.app

**Logs:**
```bash
railway logs
```

Or in Railway Dashboard.

---

## 🎊 Success!

You now have:
- ✅ Clean deployment with minimal files
- ✅ Auto-deploy from GitLab
- ✅ HTTPS enabled
- ✅ Production-ready with Gunicorn
- ✅ Health monitoring
- ✅ Persistent database

**Your ProjectFlow is live!** 🚀

Visit: `https://your-app.railway.app/api/app`

Start managing your projects! 🎉
