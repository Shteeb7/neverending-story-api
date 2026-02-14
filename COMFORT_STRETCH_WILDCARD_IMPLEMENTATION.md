# Comfort/Stretch/Wildcard Premise Generation Framework

## Overview

Replaced generic "3 unique premises" system with intentional three-tier discovery engine. Every premise set contains:

1. **COMFORT** — Direct preference match ("I know exactly what you want")
2. **STRETCH** — Unexpected combination of their stated preferences
3. **WILDCARD** — Surprise based on emotional drivers, not stated genres

This is the core of Mythweaver's recommendation engine.

---

## Changes Implemented

### Part A: Database Migrations ✅

**Migration 004:** `004_premise_tier_and_discovery_tolerance.sql`

```sql
-- Add premise_tier to stories table
ALTER TABLE stories ADD COLUMN IF NOT EXISTS premise_tier TEXT
  CHECK (premise_tier IN ('comfort', 'stretch', 'wildcard'));

-- Add discovery_tolerance to user_preferences table
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS discovery_tolerance NUMERIC DEFAULT 0.5;

-- Add index for performance
CREATE INDEX IF NOT EXISTS idx_stories_premise_tier ON stories(premise_tier);
```

**Discovery Tolerance Scale:**
- `0.0 - 0.3` = Comfort-seeker (gentle surprises)
- `0.4 - 0.6` = Balanced explorer
- `0.7 - 1.0` = Bold adventurer (genre departures welcome)

---

### Part B: Rewrite generatePremises() ✅

**Location:** `src/services/generation.js`, lines 386-498

**New Data Fetching:**
```javascript
// 1. Fetch discovery tolerance and emotional drivers
const { data: userPrefs } = await supabaseAdmin
  .from('user_preferences')
  .select('discovery_tolerance, preferences')
  .eq('user_id', userId)
  .order('created_at', { ascending: false })
  .limit(1)
  .maybeSingle();

const discoveryTolerance = userPrefs?.discovery_tolerance ?? 0.5;
const emotionalDrivers = userPrefs?.preferences?.emotionalDrivers || [];
const belovedStories = userPrefs?.preferences?.belovedStories || [];

// 2. Fetch reading history to avoid repetition
const { data: readHistory } = await supabaseAdmin
  .from('stories')
  .select('title, genre, premise_tier')
  .eq('user_id', userId)
  .order('created_at', { ascending: false })
  .limit(20);

const previousTitles = (readHistory || []).map(s => s.title).filter(Boolean);
```

**New Prompt Structure:**

The prompt now explicitly instructs Prospero to generate three distinct premise types:

**PREMISE 1 — COMFORT:**
- Lands squarely within stated genre/theme preferences
- The "safe bet" that should be VERY tempting
- Direct alignment with what they've told you they love

**PREMISE 2 — STRETCH:**
- Combines 2+ elements from their profile in unexpected ways
- Maybe collides two favorite genres
- Maybe takes beloved theme into unexpected setting
- Every ingredient from their profile, but fresh combination
- Reaction: "I never would have asked for this, but... I'm intrigued"

**PREMISE 3 — WILDCARD:**
- Curated surprise based on EMOTIONAL DRIVERS (why they read)
- Different genre/setting that delivers same emotional payload
- Uses TRISOCIATION: emotional driver + profile theme + unexpected genre
- Calibrated by discovery_tolerance (gentle → bold)
- Respects avoid-list and age range
- Reaction: "I never would have asked for this. But three chapters in, I'm hooked"

**Wildcard Calibration:**
```javascript
const wildcardCalibration = discoveryTolerance >= 0.7
  ? 'HIGH tolerance — genuine genre departure. Take emotional driver and transplant into genre they have NEVER mentioned. Be bold.'
  : discoveryTolerance >= 0.4
  ? 'MEDIUM tolerance — stay in related genre family but take unexpected thematic/setting angle they would not predict.'
  : 'LOW tolerance — stay within preferred genres but approach from surprising angle or subgenre they haven\'t explored. Gentle surprise, not shock.';
```

**Tier Validation:**
```javascript
// After parsing Claude response, validate tier tags
const validTiers = ['comfort', 'stretch', 'wildcard'];
const premisesWithIds = parsed.premises.map((premise, i) => {
  if (!premise.tier || !validTiers.includes(premise.tier)) {
    // Fallback: assign by position
    premise.tier = validTiers[i] || 'comfort';
  }
  return {
    id: crypto.randomUUID(),
    ...premise
  };
});
```

---

### Part C: Store premise_tier on Story Creation ✅

**Book 1 Creation** (`src/routes/story.js`, line 89):
```javascript
const { data: story, error: storyError } = await supabaseAdmin
  .from('stories')
  .insert({
    user_id: userId,
    premise_id: storyPremisesRecordId,
    title: selectedPremise.title,
    genre: selectedPremise.genre || null,
    description: selectedPremise.description || null,
    premise_tier: selectedPremise.tier || null,  // NEW: Store tier
    status: 'active',
    // ... rest
  })
```

**Book 2 (Sequel) Creation** (`src/routes/story.js`, line 466):
```javascript
const { data: book2Story, error: book2Error } = await supabaseAdmin
  .from('stories')
  .insert({
    user_id: userId,
    series_id: seriesId,
    book_number: 2,
    parent_story_id: storyId,
    title: book2BibleContent.title,
    genre: book1Story.genre || null,
    premise_tier: book1Story.premise_tier || null, // NEW: Inherit tier from Book 1
    status: 'generating',
    // ... rest
  })
```

**Note:** Sequels inherit `premise_tier` from Book 1 since they're a continuation of the original reader choice, not a new selection.

---

### Part D: Testing ✅

**Test Script:** `test-three-tier-premises.js`

**Manual Testing Steps:**

1. **Generate premises in production:**
   ```bash
   # Via iOS app: tap "Talk to Prospero" → complete interview
   # Or via API: POST /onboarding/generate-premises
   ```

2. **Verify output:**
   ```sql
   -- Check latest premise set
   SELECT
     premises->0->>'title' as comfort_title,
     premises->0->>'tier' as comfort_tier,
     premises->1->>'title' as stretch_title,
     premises->1->>'tier' as stretch_tier,
     premises->2->>'title' as wildcard_title,
     premises->2->>'tier' as wildcard_tier
   FROM story_premises
   WHERE user_id = 'a3f8818e-2ffe-4d61-bfbe-7f96d1d78a7b'
   ORDER BY generated_at DESC
   LIMIT 1;
   ```

3. **Create a story and verify tier stored:**
   ```sql
   SELECT id, title, genre, premise_tier
   FROM stories
   WHERE user_id = 'a3f8818e-2ffe-4d61-bfbe-7f96d1d78a7b'
   ORDER BY created_at DESC
   LIMIT 1;
   ```

---

## Validation Checklist

- [ ] All three tiers present in generated premises
- [ ] COMFORT premise feels like direct preference match
- [ ] STRETCH premise combines profile elements unexpectedly
- [ ] WILDCARD premise surprises based on emotional drivers (not stated genres)
- [ ] No title repetition from reading history
- [ ] All premises have unique genres/settings
- [ ] Wildcard calibrated by discovery_tolerance (check if bold/gentle)
- [ ] `premise_tier` stored in stories table on selection
- [ ] Book 2 sequels inherit `premise_tier` from Book 1

---

## Analytics Potential

With `premise_tier` tracked in the `stories` table, we can now analyze:

1. **Reader preference distribution:**
   - What % of readers choose comfort vs stretch vs wildcard?
   - Does discovery_tolerance predict their choice?

2. **Completion rates by tier:**
   - Do comfort stories have higher completion rates?
   - Do wildcard stories surprise readers into finishing?

3. **Evolution over time:**
   - Do readers start with comfort, then graduate to wildcard?
   - Does reading history correlate with tier selection?

4. **Calibration feedback:**
   - Are "stretch" premises actually stretching readers?
   - Are "wildcard" premises actually surprising?

---

## Future Enhancements

1. **Dynamic tier ordering:**
   - Show wildcard first for high discovery_tolerance readers
   - Show comfort first for low discovery_tolerance readers

2. **Tier-based labels in UI:**
   - Tag premises with "Your Style", "New Territory", "Surprise Me"
   - Let readers explicitly request tier type

3. **Learning from selection:**
   - If reader consistently picks wildcard, increase discovery_tolerance
   - If reader consistently picks comfort, decrease discovery_tolerance

4. **Premise regeneration:**
   - "Give me 3 more wildcards"
   - "I want safer options"

---

## Implementation Notes

- **No breaking changes:** Existing premises without `tier` field will work (fallback to null)
- **Backwards compatible:** Old user_preferences without `discovery_tolerance` default to 0.5
- **Validation:** Tier tags validated after Claude response (fallback to position-based assignment)
- **Cost:** Same token usage as before (~4000 tokens per premise set)

---

## Testing Output Example

```
🎯 COMFORT: "The Last Spellscribe"
   Genre: Epic Fantasy
   Description: In a world where magic is fading, you discover you're the last person capable of writing new spells...

🎯 STRETCH: "Respawn: Renaissance Florence"
   Genre: Historical LitRPG
   Description: You thought being reborn into the past was a curse, until you discovered the System runs on Renaissance art...

🎯 WILDCARD: "The Quiet Astronaut"
   Genre: Hard Sci-Fi Character Study
   Description: A non-verbal astronaut must navigate first contact when humanity's delegation arrives at an alien megastructure...
```

(Example shows how emotional driver "feeling deeply" + theme "coming of age" + unexpected genre "hard sci-fi" creates wildcard)
