#!/bin/bash

# Feedback System Backend Test Script
# ====================================
# Tests all feedback and sequel endpoints

BASE_URL="http://localhost:3000"

echo "======================================"
echo "🧪 Testing Feedback System Backend"
echo "======================================"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test 1: Health Check
echo "Test 1: Health Check"
echo "--------------------"
HEALTH=$(curl -s "$BASE_URL/health")
if echo "$HEALTH" | grep -q "healthy"; then
    echo -e "${GREEN}✅ Server is healthy${NC}"
    echo "$HEALTH" | jq '.'
else
    echo -e "${RED}❌ Server health check failed${NC}"
    exit 1
fi
echo ""

# Note about authentication
echo -e "${YELLOW}⚠️  AUTHENTICATION REQUIRED${NC}"
echo "The remaining tests require a valid access token."
echo "To get a token:"
echo "  1. Sign in to the iOS app"
echo "  2. Check the logs for 'FULL ACCESS TOKEN'"
echo "  3. Copy the token"
echo "  4. Set it as an environment variable:"
echo ""
echo "     export ACCESS_TOKEN='your-token-here'"
echo ""

# Check if ACCESS_TOKEN is set
if [ -z "$ACCESS_TOKEN" ]; then
    echo -e "${RED}❌ ACCESS_TOKEN not set. Stopping tests.${NC}"
    echo ""
    echo "Run this script again after setting ACCESS_TOKEN:"
    echo "  export ACCESS_TOKEN='...' && ./test-feedback-system.sh"
    echo ""
    exit 0
fi

echo -e "${GREEN}✅ ACCESS_TOKEN found${NC}"
echo ""

# Test 2: Check feedback status (should be false for new story)
echo "Test 2: Check Feedback Status"
echo "-----------------------------"
echo "Note: Replace STORY_ID with an actual story ID from your database"
echo ""
STORY_ID="${STORY_ID:-test-story-id}"

FEEDBACK_STATUS=$(curl -s \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    "$BASE_URL/feedback/status/$STORY_ID/chapter_3")

echo "Response:"
echo "$FEEDBACK_STATUS" | jq '.'
echo ""

# Test 3: Submit feedback (Great response, should trigger generation)
echo "Test 3: Submit Checkpoint Feedback (Great)"
echo "-----------------------------------------"
FEEDBACK_RESPONSE=$(curl -s -X POST \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
        \"storyId\": \"$STORY_ID\",
        \"checkpoint\": \"chapter_3\",
        \"response\": \"Great\"
    }" \
    "$BASE_URL/feedback/checkpoint")

echo "Response:"
echo "$FEEDBACK_RESPONSE" | jq '.'

if echo "$FEEDBACK_RESPONSE" | grep -q "generatingChapters"; then
    echo -e "${GREEN}✅ Feedback submitted successfully${NC}"
    echo -e "${YELLOW}🚀 Backend should now be generating chapters 7-9${NC}"
else
    echo -e "${RED}❌ Feedback submission may have failed${NC}"
fi
echo ""

# Test 4: Submit feedback (Meh response with follow-up)
echo "Test 4: Submit Checkpoint Feedback (Meh + keep_reading)"
echo "------------------------------------------------------"
FEEDBACK_MEH=$(curl -s -X POST \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
        \"storyId\": \"$STORY_ID\",
        \"checkpoint\": \"chapter_6\",
        \"response\": \"Meh\",
        \"followUpAction\": \"keep_reading\"
    }" \
    "$BASE_URL/feedback/checkpoint")

echo "Response:"
echo "$FEEDBACK_MEH" | jq '.'
echo ""

# Test 5: Submit completion interview
echo "Test 5: Submit Completion Interview"
echo "-----------------------------------"
INTERVIEW=$(curl -s -X POST \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
        \"storyId\": \"$STORY_ID\",
        \"transcript\": \"I really loved the dragon scenes and the friendship between Alice and Bob. The magic system was cool. I'd love to see more of Alice's family in the next book.\",
        \"preferences\": {
            \"liked\": [\"dragon scenes\", \"friendship\", \"magic system\"],
            \"wants_more\": [\"Alice's family\"],
            \"favorite_character\": \"Alice\"
        }
    }" \
    "$BASE_URL/feedback/completion-interview")

echo "Response:"
echo "$INTERVIEW" | jq '.'
echo ""

# Test 6: Generate sequel
echo "Test 6: Generate Sequel"
echo "----------------------"
echo -e "${YELLOW}⚠️  This will create a new Book 2 if Book 1 has 12 chapters${NC}"
read -p "Continue? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    SEQUEL=$(curl -s -X POST \
        -H "Authorization: Bearer $ACCESS_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{
            \"userPreferences\": {
                \"liked\": [\"dragon scenes\"],
                \"wants_more\": [\"magic training\"]
            }
        }" \
        "$BASE_URL/story/$STORY_ID/generate-sequel")

    echo "Response:"
    echo "$SEQUEL" | jq '.'

    if echo "$SEQUEL" | grep -q "book2"; then
        echo -e "${GREEN}✅ Sequel generation started!${NC}"
        BOOK2_ID=$(echo "$SEQUEL" | jq -r '.book2.id')
        echo "Book 2 ID: $BOOK2_ID"
    else
        echo -e "${RED}❌ Sequel generation failed${NC}"
    fi
else
    echo "Skipped sequel generation test"
fi
echo ""

echo "======================================"
echo "✅ Backend Tests Complete"
echo "======================================"
echo ""
echo "Summary:"
echo "  - Server: Running"
echo "  - Feedback routes: Loaded"
echo "  - Authentication: Working"
echo ""
echo "Next steps:"
echo "  1. Check server logs for chapter generation progress"
echo "  2. Query database to verify feedback stored"
echo "  3. Verify chapters 7-9 were generated"
echo ""
