#!/bin/bash

# Test script for onboarding flow
# Run this to verify the backend is working without doing the voice interview

set -e  # Exit on error

API_BASE="https://neverending-story-api-production.up.railway.app"

echo "=================================="
echo "🧪 Testing Onboarding Flow"
echo "=================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# You need to provide a valid Supabase access token
echo -n "${YELLOW}Enter your Supabase access token (from iOS app): ${NC}"
read -r AUTH_TOKEN

if [ -z "$AUTH_TOKEN" ]; then
    echo "${RED}❌ No token provided${NC}"
    exit 1
fi

echo ""
echo "Step 1: Testing /health endpoint..."
HEALTH=$(curl -s "$API_BASE/health")
if echo "$HEALTH" | grep -q "healthy"; then
    echo "${GREEN}✅ Health check passed${NC}"
else
    echo "${RED}❌ Health check failed${NC}"
    echo "$HEALTH"
    exit 1
fi

echo ""
echo "Step 2: Testing authentication..."
AUTH_TEST=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    "$API_BASE/onboarding/premises/test-user-id" 2>&1)

HTTP_CODE=$(echo "$AUTH_TEST" | tail -1)
RESPONSE=$(echo "$AUTH_TEST" | sed '$d')

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "404" ]; then
    echo "${GREEN}✅ Authentication working (got $HTTP_CODE)${NC}"
else
    echo "${RED}❌ Authentication failed (got $HTTP_CODE)${NC}"
    echo "Response: $RESPONSE"
    if [ "$HTTP_CODE" = "401" ]; then
        echo "${YELLOW}Token might be expired. Get a fresh one from the iOS app.${NC}"
    fi
    exit 1
fi

echo ""
echo "Step 3: Testing /process-transcript endpoint..."
TRANSCRIPT='You: My name is Test User
AI: Welcome! What stories do you love?
You: I love fantasy and sci-fi
AI: What draws you to those genres?
You: Magic and adventure
AI: What kind of characters do you like?
You: Brave heroes and clever wizards'

PROCESS_RESULT=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"transcript\": \"$TRANSCRIPT\", \"sessionId\": \"test-session\"}" \
    "$API_BASE/onboarding/process-transcript" 2>&1)

HTTP_CODE=$(echo "$PROCESS_RESULT" | tail -1)
RESPONSE=$(echo "$PROCESS_RESULT" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
    echo "${GREEN}✅ Transcript processing passed${NC}"
    echo "Response: $RESPONSE" | head -c 200
    echo "..."
else
    echo "${RED}❌ Transcript processing failed (got $HTTP_CODE)${NC}"
    echo "Response: $RESPONSE"
    exit 1
fi

echo ""
echo ""
echo "Step 4: Testing /generate-premises endpoint..."
echo "${YELLOW}⏳ This takes 2-3 minutes (generating AI stories)...${NC}"

PREMISES_RESULT=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    "$API_BASE/onboarding/generate-premises" 2>&1)

HTTP_CODE=$(echo "$PREMISES_RESULT" | tail -1)
RESPONSE=$(echo "$PREMISES_RESULT" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
    echo "${GREEN}✅ Premise generation passed${NC}"
    echo "Response preview:"
    echo "$RESPONSE" | head -c 300
    echo "..."
else
    echo "${RED}❌ Premise generation failed (got $HTTP_CODE)${NC}"
    echo "Response: $RESPONSE"
    exit 1
fi

echo ""
echo "=================================="
echo "${GREEN}🎉 All tests passed!${NC}"
echo "=================================="
echo ""
echo "The backend is working correctly."
echo "If the iOS app still fails, the issue is in the app code."
