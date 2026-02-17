# ANTHROPIC_API_KEY Setup for Supabase Edge Functions

## Required Action

The Edge Function `analyze-bug-report` requires `ANTHROPIC_API_KEY` to be set as a Supabase secret.

### API Key Value
Get the value from Railway environment or the local .env file:
```bash
# From Railway: Check Railway dashboard environment variables for ANTHROPIC_API_KEY
# From local .env: grep ANTHROPIC_API_KEY .env
```

### Method 1: Supabase CLI (Recommended)
```bash
# Get the key value first, then run:
supabase secrets set ANTHROPIC_API_KEY=<your_key_here> --project-ref hszuuvkfgdfqgtaycojz
```

### Method 2: Supabase Dashboard
1. Go to: https://supabase.com/dashboard/project/hszuuvkfgdfqgtaycojz/settings/functions
2. Navigate to "Edge Functions" → "Secrets"
3. Add new secret:
   - Name: `ANTHROPIC_API_KEY`
   - Value: (get from Railway or .env file)

## Verification

After setting the secret, the Edge Function will be able to call Claude API. If the secret is not set, bug reports will be set to 'error' status with message: "ANTHROPIC_API_KEY not configured in Supabase secrets"

## Status

⏳ Waiting for secret to be set via CLI or Dashboard
