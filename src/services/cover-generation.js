const { openai } = require('../config/ai-clients');
const { supabaseAdmin } = require('../config/supabase');

// OpenAI DALL-E 3 / gpt-image-1 pricing (as of Feb 2026)
// HD quality, 1024×1536 (similar to 1024×1792): $0.12 per image
const IMAGE_GENERATION_COST = 0.12;

/**
 * Log API cost to database for OpenAI image generation
 */
async function logImageCost(userId, storyId, operation, metadata = {}) {
  try {
    await supabaseAdmin
      .from('api_costs')
      .insert({
        user_id: userId,
        story_id: storyId,
        provider: 'openai',
        model: 'gpt-image-1',
        operation,
        input_tokens: 0,  // Image generation doesn't use token-based pricing
        output_tokens: 0,
        total_tokens: 0,
        cost: IMAGE_GENERATION_COST,
        metadata,
        created_at: new Date().toISOString()
      });
  } catch (error) {
    // Don't throw on cost logging failures - log to console instead
    console.error('Failed to log image generation cost:', error);
  }
}

/**
 * Ensure the book-covers storage bucket exists (idempotent).
 */
async function ensureBucketExists() {
  try {
    const { data: buckets } = await supabaseAdmin.storage.listBuckets();
    const exists = buckets?.some(b => b.name === 'book-covers');

    if (!exists) {
      console.log('📦 Creating book-covers storage bucket...');
      const { error } = await supabaseAdmin.storage.createBucket('book-covers', {
        public: true,
        fileSizeLimit: 5242880 // 5MB
      });

      if (error && !error.message.includes('already exists')) {
        console.error('Failed to create book-covers bucket:', error.message);
        throw error;
      }

      console.log('✅ book-covers bucket created');
    }
  } catch (error) {
    console.error('Error checking/creating bucket:', error.message);
    throw error;
  }
}

/**
 * Generate a book cover image using OpenAI and store it in Supabase Storage.
 *
 * @param {string} storyId - The story ID
 * @param {object} storyDetails - { title, genre, bible }
 * @param {string} authorName - Reader's name to display as author
 * @returns {string} Public URL of the stored cover image
 */
async function generateBookCover(storyId, storyDetails, authorName) {
  const { title, genre, bible } = storyDetails;

  console.log(`🎨 Generating cover for "${title}" by ${authorName}`);

  // Ensure the storage bucket exists
  await ensureBucketExists();

  // Step 1: Generate the image with OpenAI
  const prompt = buildCoverPrompt(title, genre, bible, authorName);

  const response = await openai.images.generate({
    model: 'gpt-image-1',
    prompt: prompt,
    n: 1,
    size: '1024x1536',
    quality: 'high'
  });

  // gpt-image-1 returns base64 data, not a URL
  const b64_json = response.data[0].b64_json;

  if (!b64_json) {
    throw new Error('OpenAI returned no image data');
  }

  // Log cost for image generation (fetch userId from story)
  const { data: story } = await supabaseAdmin
    .from('stories')
    .select('user_id')
    .eq('id', storyId)
    .single();

  if (story?.user_id) {
    await logImageCost(story.user_id, storyId, 'cover_generation', {
      title,
      size: '1024x1536',
      quality: 'high'
    });
  }

  // Step 2: Decode base64 to buffer
  const imageBuffer = Buffer.from(b64_json, 'base64');

  // Step 3: Upload to Supabase Storage
  const fileName = `covers/${storyId}.png`;

  const { data: uploadData, error: uploadError } = await supabaseAdmin
    .storage
    .from('book-covers')
    .upload(fileName, imageBuffer, {
      contentType: 'image/png',
      upsert: true // Overwrite if regenerating
    });

  if (uploadError) {
    throw new Error(`Failed to upload cover: ${uploadError.message}`);
  }

  // Step 4: Get the public URL
  const { data: urlData } = supabaseAdmin
    .storage
    .from('book-covers')
    .getPublicUrl(fileName);

  const publicUrl = urlData.publicUrl;

  // Step 5: Update the story record with the cover URL
  const { error: updateError } = await supabaseAdmin
    .from('stories')
    .update({ cover_image_url: publicUrl })
    .eq('id', storyId);

  if (updateError) {
    console.error(`⚠️ Failed to update story cover URL: ${updateError.message}`);
    // Non-fatal — the cover exists in storage even if we can't update the record
  }

  console.log(`✅ Cover generated and stored: ${publicUrl}`);
  return publicUrl;
}

/**
 * Spell out title character-by-character for better text rendering.
 */
function spellOutTitle(title) {
  return title.toUpperCase().split('').map(c => {
    if (c === ':') return 'colon';
    if (c === ' ') return 'space';
    if (c === '-') return 'dash';
    if (c === "'") return 'apostrophe';
    return c;
  }).join('-');
}

/**
 * Select art style based on genre to create varied, genre-appropriate covers.
 */
function getArtStyle(genre) {
  const g = (genre || '').toLowerCase();

  if (g.includes('litrpg') || g.includes('gamelit'))
    return 'digital fantasy art style, vibrant colors, game-inspired aesthetic with glowing UI elements';
  if (g.includes('sci-fi') || g.includes('space') || g.includes('protocol'))
    return 'sleek sci-fi concept art, neon accents, dark metallic tones, cinematic lighting';
  if (g.includes('horror') || g.includes('gothic') || g.includes('plague'))
    return 'dark gothic illustration, muted earth tones with splashes of crimson, heavy shadow and atmosphere';
  if (g.includes('whimsical') || g.includes('gaslamp'))
    return 'whimsical watercolor illustration, warm golden tones, intricate linework, storybook charm';
  if (g.includes('heroic') || g.includes('epic'))
    return 'oil painting style, sweeping heroic composition, warm firelight and cool shadow contrast';
  if (g.includes('mythic'))
    return 'luminous mythological painting, celestial color palette, ethereal atmospheric perspective';
  if (g.includes('dying earth') || g.includes('post'))
    return 'weathered illustration style, faded maritime palette, textured like aged parchment';
  if (g.includes('mystery') || g.includes('thriller'))
    return 'moody noir illustration, high contrast, deep shadows with single dramatic light source';
  if (g.includes('romance'))
    return 'soft romantic illustration, warm sunset palette, flowing organic composition';
  if (g.includes('adventure'))
    return 'dynamic adventure illustration, saturated colors, bold composition with sense of movement';

  // Default
  return 'richly detailed book cover illustration, dramatic composition, cinematic lighting';
}

/**
 * Build the OpenAI image generation prompt for a book cover using story bible data.
 */
function buildCoverPrompt(title, genre, bible, authorName) {
  const artStyle = getArtStyle(genre);
  const spelledTitle = spellOutTitle(title);
  const upperTitle = title.toUpperCase();
  const upperAuthor = authorName.toUpperCase();

  // Extract the protagonist from bible characters
  const characters = bible?.characters || [];
  const protagonist = characters[0]; // First character is usually the lead

  // Extract the most visual location
  const locations = bible?.key_locations || [];
  const primaryLocation = locations[0];

  // Extract conflict for mood
  const conflict = bible?.central_conflict;
  const conflictDesc = typeof conflict === 'string'
    ? conflict
    : conflict?.description || '';

  // Extract themes for symbolism
  const themes = bible?.themes || [];
  const themeStr = Array.isArray(themes) ? themes.join(', ') : (themes || '');

  // Build a character description for the cover
  let characterLine = '';
  if (protagonist) {
    const name = protagonist.name || '';
    const appearance = protagonist.appearance || protagonist.description || '';
    characterLine = `The central figure is ${name}, ${appearance}.`;
  }

  // Build a setting description
  let settingLine = '';
  if (primaryLocation) {
    const locName = primaryLocation.name || '';
    const locDesc = primaryLocation.description || '';
    settingLine = `The setting is ${locName}: ${locDesc}.`;
  }

  return `Design a unique book cover for a ${genre} novel titled "${upperTitle}".

VISUAL SCENE:
${characterLine}
${settingLine}
The story's central tension: ${conflictDesc}
Themes: ${themeStr}

ART STYLE: ${artStyle}

TEXT LAYOUT:
At the top: "${upperTitle}" — spelled ${spelledTitle} — in bold, genre-appropriate display font, large and centered, with strong contrast against the background.
At the bottom: "${upperAuthor}" in smaller clean font, centered.

REQUIREMENTS:
- Flat, front-facing rectangular artwork filling the entire canvas edge-to-edge
- Genre-appropriate color palette that reflects the story's mood
- All text perfectly legible with no extra characters
- Do NOT render a 3D book object, spine, or pages
- No borders or margins
- Include padding so no text is cut off`;
}

module.exports = {
  generateBookCover,
  buildCoverPrompt
};
