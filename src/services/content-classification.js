const Anthropic = require('@anthropic-ai/sdk');
const { supabaseAdmin } = require('../config/supabase');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const MODEL = 'claude-sonnet-4-5-20250929';

/**
 * Get existing classification for a story if one exists
 * @param {string} storyId - The story ID
 * @returns {Promise<{rating: string, reason: string} | null>} - Existing classification or null
 */
async function getExistingClassification(storyId) {
  const { data: review, error } = await supabaseAdmin
    .from('content_reviews')
    .select('ai_rating, final_rating, status')
    .eq('story_id', storyId)
    .in('status', ['resolved', 'pending_review'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !review) {
    return null;
  }

  // Use final_rating if available (after dispute), otherwise ai_rating
  const rating = review.final_rating || review.ai_rating;
  return {
    rating,
    reason: 'Previously classified'
  };
}

/**
 * Classify story content for maturity rating
 * @param {string} storyId - The story ID to classify
 * @returns {Promise<{rating: string, reason: string}>} - The maturity rating and explanation
 */
async function classifyStoryContent(storyId) {
  // Check for existing classification first
  const existing = await getExistingClassification(storyId);
  if (existing) {
    console.log(`📋 [Classification] Using cached classification for story ${storyId}: ${existing.rating}`);
    return existing;
  }
  console.log(`📋 [Classification] Starting classification for story ${storyId}`);

  // Fetch the story
  const { data: story, error: storyError } = await supabaseAdmin
    .from('stories')
    .select('id, title')
    .eq('id', storyId)
    .single();

  if (storyError || !story) {
    throw new Error(`Story not found: ${storyId}`);
  }

  // Fetch all chapters
  const { data: chapters, error: chaptersError } = await supabaseAdmin
    .from('chapters')
    .select('chapter_number, content')
    .eq('story_id', storyId)
    .order('chapter_number', { ascending: true });

  if (chaptersError) {
    throw new Error(`Failed to fetch chapters: ${chaptersError.message}`);
  }

  if (!chapters || chapters.length === 0) {
    throw new Error('Story has no chapters to classify');
  }

  // Concatenate all chapter content
  const fullStoryText = chapters
    .map(ch => `CHAPTER ${ch.chapter_number}\n\n${ch.content}`)
    .join('\n\n---\n\n');

  // Build classification prompt (calibrated for better accuracy)
  const classificationPrompt = `You are a content classifier for Mythweaver, a personalized fiction platform. Read the following story and classify its maturity level.

MATURITY LEVELS (use the LOWEST appropriate tier):

all_ages — Suitable for all readers. May include:
- Mild conflict, cartoon-style action, pratfalls
- Characters in peril that resolves safely
- Themes of friendship, courage, discovery
- No profanity, no romantic content beyond hand-holding
- Examples: Charlotte's Web, Percy Jackson (book 1), Narnia

teen_13 — Suitable for teens 13+. May include:
- Action violence (sword fights, battles, explosions) without graphic gore or torture
- Characters can die, but death is not dwelt on with graphic physical detail
- Mild profanity (damn, hell) used sparingly
- Romantic tension, kissing, implied attraction — but no explicit sexual content
- Dark themes (war, loss, injustice, moral ambiguity) handled without nihilism
- Horror atmosphere and tension without sustained graphic body horror
- Examples: Harry Potter (books 4-7), Hunger Games, Pirates of the Caribbean, Lord of the Rings

mature_17 — For mature readers 17+. Contains one or more of:
- Graphic violence with detailed physical descriptions of injury, torture, or gore
- Explicit sexual content or detailed nudity
- Heavy/frequent profanity (f-word, slurs)
- Sustained psychological horror, graphic body horror
- Detailed depictions of drug use, self-harm, or abuse
- Examples: Game of Thrones, The Road, American Psycho

IMPORTANT: Lean toward the LOWER rating when content is borderline. Action-adventure violence (battles, chases, peril) is teen_13, not mature_17, unless it includes graphic gore or torture. Fantasy/sci-fi tropes (monsters, magical combat, post-apocalyptic settings) are not inherently mature.

Return EXACTLY ONE of: all_ages, teen_13, mature_17

Then provide a brief explanation (2-3 sentences) of why you chose this rating, citing specific content from the story.

Format your response EXACTLY like this:
RATING: [rating]
REASON: [explanation]

Story to classify:

${fullStoryText}`;

  const messages = [{ role: 'user', content: classificationPrompt }];

  // Call Claude API
  console.log(`🤖 [${story.title}] Calling Claude for content classification...`);
  const apiStartTime = Date.now();

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages
  });

  const apiDuration = ((Date.now() - apiStartTime) / 1000).toFixed(1);
  const responseText = response.content[0].text;

  console.log(`🤖 [${story.title}] Classification complete (${apiDuration}s)`);

  // Parse response
  const ratingMatch = responseText.match(/RATING:\s*(all_ages|teen_13|mature_17)/i);
  const reasonMatch = responseText.match(/REASON:\s*(.+)/is);

  if (!ratingMatch) {
    console.error('❌ Failed to parse rating from Claude response:', responseText);
    throw new Error('Failed to parse classification rating from AI response');
  }

  const rating = ratingMatch[1].toLowerCase();
  const reason = reasonMatch ? reasonMatch[1].trim() : 'No reason provided';

  console.log(`📋 [${story.title}] Classified as: ${rating}`);

  return {
    rating,
    reason
  };
}

module.exports = {
  classifyStoryContent,
  getExistingClassification
};
