# Railway Deployment Guide

## Quick Deploy Steps

### Option 1: Deploy via Railway Dashboard (Recommended - Easiest)

1. **Push to GitHub** (if not already done)
   ```bash
   # Create a new repository on GitHub first, then:
   git remote add origin https://github.com/YOUR_USERNAME/neverending-story-api.git
   git push -u origin main
   ```

2. **Deploy on Railway**
   - Go to https://railway.app
   - Click "New Project"
   - Select "Deploy from GitHub repo"
   - Authorize Railway to access your GitHub
   - Select the `neverending-story-api` repository
   - Railway will automatically detect the Node.js app and deploy it

3. **Add Environment Variables**
   - In Railway dashboard, go to your project
   - Click on the service
   - Go to "Variables" tab
   - Add these variables:
     ```
     SUPABASE_URL=https://hszuuvkfgdfqgtaycojz.supabase.co
     SUPABASE_ANON_KEY=<your-anon-key>
     SUPABASE_SERVICE_KEY=<your-service-key>
     ANTHROPIC_API_KEY=<your-anthropic-key>
     OPENAI_API_KEY=<your-openai-key>
     NODE_ENV=production
     ```

4. **Generate Domain**
   - Go to "Settings" tab
   - Click "Generate Domain" under "Domains"
   - Your API will be available at: `https://your-app.up.railway.app`

### Option 2: Deploy via Railway CLI

1. **Login to Railway**
   ```bash
   railway login
   ```
   This will open a browser for authentication.

2. **Initialize Project**
   ```bash
   railway init
   ```
   Choose "Create a new project" and give it a name like "neverending-story-api"

3. **Add Environment Variables**
   ```bash
   railway variables set SUPABASE_URL="https://hszuuvkfgdfqgtaycojz.supabase.co"
   railway variables set SUPABASE_ANON_KEY="<your-anon-key>"
   railway variables set SUPABASE_SERVICE_KEY="<your-service-key>"
   railway variables set ANTHROPIC_API_KEY="<your-anthropic-key>"
   railway variables set OPENAI_API_KEY="<your-openai-key>"
   railway variables set NODE_ENV="production"
   ```

4. **Deploy**
   ```bash
   railway up
   ```

5. **Get Your URL**
   ```bash
   railway domain
   ```

   Or generate a domain:
   ```bash
   railway domain --generate
   ```

### Option 3: Deploy via GitHub Integration (Most Automated)

1. **Connect Railway to GitHub**
   - Go to https://railway.app
   - Login and go to Account Settings
   - Connect your GitHub account

2. **Create New Project**
   - Click "New Project" → "Deploy from GitHub repo"
   - Select your repository
   - Railway auto-detects the configuration from `railway.json`

3. **Configure Environment Variables** (in Railway Dashboard)
   - Click on your service → Variables tab
   - Add all required variables

4. **Automatic Deployments**
   - Every push to `main` will automatically deploy
   - Pull requests create preview environments

## After Deployment

### 1. Get Your Deployment URL
From Railway dashboard or CLI:
```bash
railway domain
```

### 2. Test the Deployment
```bash
# Health check
curl https://your-app.up.railway.app/health

# API info
curl https://your-app.up.railway.app/

# Test auth session (requires valid token)
curl https://your-app.up.railway.app/auth/session \
  -H "Authorization: Bearer <your-supabase-jwt>"
```

### 3. Monitor Logs
```bash
railway logs
```

Or view in Railway dashboard under "Deployments" → "View Logs"

## Environment Variables Checklist

Make sure ALL of these are set in Railway:

- [ ] `SUPABASE_URL`
- [ ] `SUPABASE_ANON_KEY`
- [ ] `SUPABASE_SERVICE_KEY`
- [ ] `ANTHROPIC_API_KEY`
- [ ] `OPENAI_API_KEY`
- [ ] `NODE_ENV=production`
- [ ] `ALLOWED_ORIGINS` (optional, comma-separated)

## Troubleshooting

### Build Fails
- Check Railway logs for error messages
- Ensure all dependencies are in `package.json`
- Verify Node.js version (18+)

### App Crashes on Startup
- Check environment variables are set correctly
- View logs: `railway logs`
- Ensure all required variables are present

### Can't Connect to Database
- Verify `SUPABASE_URL` and keys are correct
- Check Supabase dashboard for connection issues
- Test Supabase connection locally first

### CORS Issues
- Set `ALLOWED_ORIGINS` environment variable
- Include your iOS app's domain/origin

## Cost Considerations

Railway offers:
- **Free tier**: $5 usage credit per month
- **Pro tier**: $20/month + usage

Your API will use:
- Compute time when running
- Bandwidth for requests/responses
- No separate database charge (using Supabase)

Monitor usage in Railway dashboard.

## Next Steps After Deployment

1. **Update iOS App**: Point your iOS app to the Railway URL
2. **Setup Database**: Create tables in Supabase (see README.md for schema)
3. **Test All Endpoints**: Use the test curl commands
4. **Monitor Performance**: Check Railway metrics dashboard
5. **Setup Alerts**: Configure Railway notifications for errors

## Support

- Railway Docs: https://docs.railway.app
- Railway Discord: https://discord.gg/railway
- Railway Status: https://status.railway.app
