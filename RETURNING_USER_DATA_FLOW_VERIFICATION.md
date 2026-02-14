# Returning User Data Flow Verification

## Summary of Changes

### ✅ Step 1: Backend Endpoint Test
**Created:** `test-returning-user-data.js`

Test script for `GET /onboarding/user-preferences/:userId`

**To run:**
```bash
cd neverending-story-api

# Set your access token (get from Supabase or iOS app)
export TEST_ACCESS_TOKEN="your_access_token_here"

# Run the test
node test-returning-user-data.js
```

**Expected output:**
- ✅ Response status: 200
- ✅ `preferences.name` present
- ✅ `preferences.genres` array present
- ✅ `preferences.themes` array present
- ✅ `preferences.mood` present
- ⚠️ New Prompt #8 fields (emotionalDrivers, belovedStories, etc.) may be absent for old users

---

### ✅ Step 2: Swift Methods Verification

**Confirmed correct data paths:**

#### `OnboardingView.swift` (lines 371-404)

1. **`fetchUserName(userId:)`**
   - ✅ Reads from: `result["name"]`
   - ✅ Source: `preferences.name` in user_preferences table

2. **`fetchPreferredGenres(userId:)`**
   - ✅ Reads from: `result["genres"]`
   - ✅ Source: `preferences.genres` array in user_preferences table
   - ✅ NOT reading from stories.genre (which was null)

3. **`fetchPreviousStoryTitles(userId:)`**
   - ✅ Queries: `stories` table by `user_id`
   - ✅ Maps: `stories.map { $0.title }`
   - ✅ Source: Populated story titles from database

---

### ✅ Step 3: Null Safety for New Prompt #8 Fields

**ReturningUserContext structure** (VoiceSessionManager.swift, lines 32-36):
```swift
struct ReturningUserContext {
    let userName: String
    let previousStoryTitles: [String]
    let preferredGenres: [String]
}
```

**✅ No crash risk:**
- New fields (emotionalDrivers, belovedStories, readingMotivation, discoveryTolerance, pacePreference) are NOT used in ReturningUserContext
- They're only collected during onboarding and stored passively in user_preferences
- Old users without these fields will work fine

**Backend null handling:**
- `onboarding.js` (lines 94-101): All new fields use `||` fallback operators
- `discoveryTolerance` defaults to `0.5` if absent (line 100)

---

### ✅ Step 4: Fixed Genre Column on Stories Table

#### **Problem:**
The `genre` column was NULL for all stories because it was never populated during story creation.

#### **Solution:**
Updated story creation to populate `genre` and `description` from premise data.

#### **Changes Made:**

**1. Book 1 Creation** (`story.js`, lines 80-99):
```javascript
const { data: story, error: storyError } = await supabaseAdmin
  .from('stories')
  .insert({
    user_id: userId,
    premise_id: storyPremisesRecordId,
    title: selectedPremise.title,
    genre: selectedPremise.genre || null,              // NEW
    description: selectedPremise.description || null,  // NEW
    status: 'active',
    // ... rest of fields
  })
```

**2. Book 2 (Sequel) Creation** (`story.js`, lines 450-471):
```javascript
const { data: book2Story, error: book2Error } = await supabaseAdmin
  .from('stories')
  .insert({
    user_id: userId,
    series_id: seriesId,
    book_number: 2,
    parent_story_id: storyId,
    title: book2BibleContent.title,
    genre: book1Story.genre || null,  // NEW: Inherit from Book 1
    status: 'generating',
    // ... rest of fields
  })
```

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ 1. ONBOARDING INTERVIEW                                     │
│    VoiceSessionManager.configureOnboardingSession()         │
│    → Collects: name, genres, themes, mood, ageRange         │
│    → NEW: emotionalDrivers, belovedStories, etc.            │
└─────────────────────────────────┬───────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. BACKEND STORAGE                                          │
│    POST /onboarding/process-transcript                      │
│    → Stores in: user_preferences table                      │
│    → preferences JSON contains all fields                   │
└─────────────────────────────────┬───────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. PREMISE GENERATION                                       │
│    POST /onboarding/generate-premises                       │
│    → Uses: preferences.genres, themes, mood                 │
│    → Returns: 3 premises with genre + description           │
└─────────────────────────────────┬───────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. STORY CREATION                                           │
│    POST /story/select-premise                               │
│    → Creates story with:                                    │
│      - title: premise.title                                 │
│      - genre: premise.genre ✅ NOW POPULATED                │
│      - description: premise.description ✅ NOW POPULATED    │
└─────────────────────────────────┬───────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. RETURNING USER INTERVIEW                                 │
│    OnboardingView (forceNewInterview=true)                  │
│    → Fetches:                                               │
│      - userName from preferences.name                       │
│      - preferredGenres from preferences.genres              │
│      - previousStoryTitles from stories table               │
│    → Configures: returningUser session context              │
└─────────────────────────────────────────────────────────────┘
```

---

## Testing Checklist

### Backend Test
- [ ] Run `node test-returning-user-data.js` with valid access token
- [ ] Verify required fields present (name, genres, themes, mood)
- [ ] Confirm new fields optional (no errors if missing)

### iOS Manual Test
- [ ] Complete new onboarding → verify genre populated in DB
- [ ] Return to PremiseSelectionView → tap "Talk to Prospero"
- [ ] Verify Prospero greets by name with previous story titles
- [ ] Complete interview → verify new story created with genre

### Database Verification
```sql
-- Check existing stories have genre
SELECT id, title, genre, description
FROM stories
WHERE user_id = 'a3f8818e-2ffe-4d61-bfbe-7f96d1d78a7b'
ORDER BY created_at DESC;

-- Check user preferences
SELECT preferences->>'name' as name,
       preferences->>'genres' as genres,
       preferences->>'emotionalDrivers' as emotional_drivers
FROM user_preferences
WHERE user_id = 'a3f8818e-2ffe-4d61-bfbe-7f96d1d78a7b';
```

---

## Expected Behavior

### For Old Users (pre-Prompt #8)
- ✅ `preferences.name` → Available
- ✅ `preferences.genres` → Available
- ✅ `preferences.themes` → Available
- ✅ `preferences.mood` → Available
- ⚠️ New fields (emotionalDrivers, etc.) → NULL/absent (safe fallback)

### For New Users (post-Prompt #8)
- ✅ All old fields → Available
- ✅ New fields → Populated from voice interview
- ✅ discoveryTolerance → Numeric value (0.2, 0.5, or 0.8)

### For All Stories Going Forward
- ✅ `stories.genre` → Populated from premise
- ✅ `stories.description` → Populated from premise
- ✅ Book 2+ → Inherits genre from Book 1

---

## Next Steps

1. **Run the test script** to verify backend endpoint
2. **Test in-app** returning user flow with existing user
3. **Create a new story** and verify genre populated in DB
4. **Generate a sequel** and verify genre inherited
