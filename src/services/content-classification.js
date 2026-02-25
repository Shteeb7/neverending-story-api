const Anthropic = require('@anthropic-ai/sdk');
const { supabaseAdmin } = require('../config/supabase');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const MODEL = 'claude-opus-4-20250514';

/**
 * Classify story content for maturity rating
 * @param {string} storyId - The story ID to classify
 * @returns {Promise<{rating: string, reason: string}>} - The maturity rating and explanation
 */
async function classifyStoryContent(storyId) {
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

  // Build classification prompt
  const classificationPrompt = `You are a content classifier for Mythweaver, a personalized fiction platform. Read the following story and classify its maturity level.

Consider:
- Violence intensity (graphic descriptions, harm to characters)
- Romantic/sexual content (implications, descriptions)
- Language (profanity, slurs)
- Dark themes (death, trauma, horror)
- Emotional intensity (fear, grief, mature psychological themes)

MATURITY LEVELS:
- all_ages: Suitable for readers of all ages (like G or PG movies)
- teen_13: Suitable for teens 13+ (like PG-13 movies - some mature themes but not graphic)
- mature_17: Suitable for mature teens 17+ (like R movies - explicit content, intense themes)

Return EXACTLY ONE of: all_ages, teen_13, mature_17

Then provide a brief explanation (2-3 sentences) of why you chose this rating.

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
  classifyStoryContent
};
