/**
 * Fantasy Name Generation Service
 *
 * Generates AI-powered fantasy display names for WhisperNet using Prospero (Claude).
 *
 * Features:
 * - Personalized based on user's reading preferences (genres, emotional themes)
 * - Uniqueness checking against existing whispernet_display_name values
 * - Rate limiting: 1 generation per user per 7 days
 * - Collision handling: regenerate up to 2 times, then append number suffix
 */

const Anthropic = require('@anthropic-ai/sdk');
const supabase = require('../config/supabase');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Generates 3 fantasy name options for a user
 * @param {string} userId - User UUID
 * @param {Object} options - Optional preferences context
 * @returns {Promise<{success: boolean, options?: string[], error?: string, retry_after?: number}>}
 */
async function generateFantasyName(userId, options = {}) {
  try {
    // 1. Check rate limit
    const { data: prefs, error: prefsError } = await supabase
      .from('user_preferences')
      .select('last_name_generation_at, preferred_genres, content_preferences')
      .eq('user_id', userId)
      .maybeSingle();

    if (prefsError) {
      console.error('❌ Error fetching user preferences:', prefsError);
      return { success: false, error: 'Failed to fetch user preferences' };
    }

    // Check if user has generated names within the last 7 days
    if (prefs?.last_name_generation_at) {
      const lastGeneration = new Date(prefs.last_name_generation_at);
      const now = new Date();
      const daysSinceLastGeneration = (now - lastGeneration) / (1000 * 60 * 60 * 24);

      if (daysSinceLastGeneration < 7) {
        const secondsRemaining = Math.ceil((7 * 24 * 60 * 60) - (daysSinceLastGeneration * 24 * 60 * 60));
        console.log(`⏱️ Rate limit: User ${userId} must wait ${secondsRemaining}s`);
        return {
          success: false,
          error: 'Rate limit exceeded',
          retry_after: secondsRemaining
        };
      }
    }

    // 2. Build personalized prompt
    let personalizedContext = '';
    if (prefs?.preferred_genres && prefs.preferred_genres.length > 0) {
      personalizedContext += `This reader loves ${prefs.preferred_genres.join(', ')}. `;
    }
    if (prefs?.content_preferences?.emotional_preferences) {
      const emotions = prefs.content_preferences.emotional_preferences;
      if (Array.isArray(emotions) && emotions.length > 0) {
        personalizedContext += `They gravitate toward ${emotions.join(', ')}. `;
      }
    }

    const basePrompt = `You are Prospero, the storyteller of Mythweaver. Generate fantasy display names for a reader. Each name should feel like it belongs in a storybook — evocative, memorable, and age-appropriate. They should NOT be real human names.

Examples of the style we're looking for:
- Thornwick
- Amberly Dusk
- Fable Wren
- Caspian Ember
- Nighthollow
- Rowan Ashvale
- Whisper Thorne

${personalizedContext ? personalizedContext + '\n' : ''}Generate exactly 3 options, each on its own line, nothing else. No numbering, no extra text, just the names.`;

    console.log('🎭 Generating fantasy names for user', userId);
    if (personalizedContext) {
      console.log('   Personalization:', personalizedContext.trim());
    }

    // 3. Call Claude API
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      temperature: 0.9, // Higher temperature for more creative names
      messages: [{
        role: 'user',
        content: basePrompt
      }]
    });

    const rawNames = response.content[0].text.trim();
    console.log('🎭 Raw Claude response:', rawNames);

    // Parse the response (one name per line)
    let nameOptions = rawNames
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && line.length <= 50) // Reasonable name length
      .slice(0, 3); // Take first 3

    if (nameOptions.length < 3) {
      console.error('❌ Claude returned fewer than 3 names:', nameOptions);
      return { success: false, error: 'Failed to generate 3 name options' };
    }

    console.log('🎭 Parsed name options:', nameOptions);

    // 4. Check uniqueness and handle collisions
    const uniqueNames = [];
    for (let i = 0; i < nameOptions.length; i++) {
      let name = nameOptions[i];
      let attempt = 0;
      let isUnique = false;

      while (attempt < 3 && !isUnique) {
        // Check if name exists
        const { data: existing, error: checkError } = await supabase
          .from('user_preferences')
          .select('user_id')
          .eq('whispernet_display_name', name)
          .maybeSingle();

        if (checkError) {
          console.error('❌ Error checking name uniqueness:', checkError);
          return { success: false, error: 'Failed to check name uniqueness' };
        }

        if (!existing) {
          // Name is unique!
          isUnique = true;
          uniqueNames.push(name);
          console.log(`✅ Name "${name}" is unique`);
        } else {
          // Collision detected
          attempt++;
          console.log(`⚠️ Name "${name}" already exists (attempt ${attempt}/3)`);

          if (attempt < 2) {
            // Try regenerating just this one name
            const retryPrompt = `You are Prospero. Generate a single fantasy display name (like "Thornwick" or "Amberly Dusk"). It should be evocative and memorable, NOT a real human name. Just return the name, nothing else.`;

            const retryResponse = await anthropic.messages.create({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 50,
              temperature: 0.9,
              messages: [{ role: 'user', content: retryPrompt }]
            });

            name = retryResponse.content[0].text.trim();
            console.log(`🔄 Regenerated name: "${name}"`);
          } else {
            // Max retries reached, append number suffix
            const suffix = Math.floor(Math.random() * 9000) + 1000;
            name = `${nameOptions[i]}${suffix}`;
            uniqueNames.push(name);
            isUnique = true;
            console.log(`🔢 Appended suffix: "${name}"`);
          }
        }
      }
    }

    if (uniqueNames.length < 3) {
      console.error('❌ Failed to generate 3 unique names');
      return { success: false, error: 'Failed to generate unique names' };
    }

    // 5. Update last_name_generation_at
    const { error: updateError } = await supabase
      .from('user_preferences')
      .update({ last_name_generation_at: new Date().toISOString() })
      .eq('user_id', userId);

    if (updateError) {
      console.error('⚠️ Failed to update last_name_generation_at:', updateError);
      // Don't fail the request, just log it
    }

    console.log('✅ Generated 3 unique fantasy names:', uniqueNames);

    return {
      success: true,
      options: uniqueNames
    };

  } catch (error) {
    console.error('❌ Fantasy name generation error:', error);
    return {
      success: false,
      error: error.message || 'Failed to generate fantasy names'
    };
  }
}

/**
 * Selects a fantasy name for the user
 * @param {string} userId - User UUID
 * @param {string} name - The selected name
 * @returns {Promise<{success: boolean, display_name?: string, error?: string}>}
 */
async function selectFantasyName(userId, name) {
  try {
    // Validate the name
    if (!name || name.trim().length === 0) {
      return { success: false, error: 'Name is required' };
    }

    if (name.length > 50) {
      return { success: false, error: 'Name is too long' };
    }

    // Check if name is already taken by someone else
    const { data: existing, error: checkError } = await supabase
      .from('user_preferences')
      .select('user_id')
      .eq('whispernet_display_name', name)
      .maybeSingle();

    if (checkError) {
      console.error('❌ Error checking name availability:', checkError);
      return { success: false, error: 'Failed to check name availability' };
    }

    if (existing && existing.user_id !== userId) {
      console.log(`⚠️ Name "${name}" is already taken by another user`);
      return { success: false, error: 'This name is already taken' };
    }

    // Set the display name
    const { error: updateError } = await supabase
      .from('user_preferences')
      .update({ whispernet_display_name: name })
      .eq('user_id', userId);

    if (updateError) {
      console.error('❌ Error setting display name:', updateError);
      return { success: false, error: 'Failed to set display name' };
    }

    console.log(`✅ User ${userId} selected fantasy name: "${name}"`);

    return {
      success: true,
      display_name: name
    };

  } catch (error) {
    console.error('❌ Fantasy name selection error:', error);
    return {
      success: false,
      error: error.message || 'Failed to select fantasy name'
    };
  }
}

module.exports = {
  generateFantasyName,
  selectFantasyName
};
