const { openai, anthropic } = require('../config/ai-clients');
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
 * Claude acts as art director — reads the story bible and produces a creative brief
 * for the cover: art style, color palette, composition concept, typography personality.
 * Each brief is unique because each bible is unique.
 */
async function generateCoverCreativeBrief(title, genre, bible) {
  const protagonist = bible?.characters?.protagonist || {};
  const antagonist = bible?.characters?.antagonist || {};
  const locations = bible?.key_locations || [];
  const themes = bible?.themes || [];
  const conflict = bible?.central_conflict;
  const narrativeVoice = bible?.narrative_voice || {};
  const stakes = bible?.stakes || {};

  const briefPrompt = `You are an award-winning book cover art director. Your job is to create a UNIQUE creative brief for a cover that would stop someone mid-scroll on a bookstore app.

STORY DNA:
Title: "${title}"
Genre: ${genre}
Protagonist: ${protagonist.name || 'Unknown'} — ${protagonist.personality || ''} ${protagonist.internal_contradiction ? `(internal conflict: ${protagonist.internal_contradiction})` : ''}
Antagonist: ${antagonist.name || 'Unknown'} — ${antagonist.motivation || ''}
Central Conflict: ${typeof conflict === 'string' ? conflict : conflict?.description || ''}
Stakes: ${stakes.personal || ''} / ${stakes.broader || stakes.emotional || ''}
Themes: ${Array.isArray(themes) ? themes.join(', ') : themes}
Key Locations: ${locations.map(l => `${l.name}: ${l.description}`).join('; ') || 'Not specified'}
Narrative Voice: ${narrativeVoice.tonal_register || 'Not specified'} / ${narrativeVoice.narrative_personality || ''}

Your brief must answer these questions. Be SPECIFIC and OPINIONATED — generic answers like "digital illustration" or "genre-appropriate serif" are failures.

1. ART STYLE: What specific visual style captures this story's soul? Think beyond "digital illustration." Consider: woodcut prints, gouache painting, paper collage, Art Nouveau, Soviet propaganda poster, Japanese ukiyo-e, oil impasto, watercolor bleed, linocut, pixel art, vintage pulp paperback, charcoal sketch, stained glass, mosaic, screenprint, botanical illustration, noir photography style, children's book illustration, graphic novel panels, map/cartographic style, textile/embroidery pattern, etc.
   Pick ONE style and explain in 1 sentence why it fits THIS story.

2. COLOR PALETTE: Name 3-4 specific colors (not generic like "blue" — say "cerulean" or "burnt sienna" or "electric chartreuse"). What's the dominant mood the palette creates?

3. CENTRAL IMAGE CONCEPT: What is the SINGLE most powerful image for this cover? This is NOT always the protagonist standing heroically. Consider:
   - A symbolic object (a key, a cracked mirror, a letter burning)
   - A landscape that tells the story (a house at the edge of a cliff)
   - An abstract concept made visual (two shadows merging, a door half-open)
   - A close-up detail (hands holding something, an eye reflecting a scene)
   - A scene frozen at a turning point
   - A pattern or texture that evokes the world
   Pick the approach that would make someone NEED to know what this book is about.

4. COMPOSITION: Where does the eye go first? What's the visual hierarchy? Is it symmetrical or dynamic? Tight crop or expansive? What occupies the negative space?

5. TYPOGRAPHY PERSONALITY: What kind of lettering captures this book's voice? NOT just "serif" or "sans-serif" — describe the PERSONALITY of the type. Examples: "hand-lettered with ink splatters like someone wrote it in a rush," "thin elegant art deco letterforms with gold leaf texture," "blocky woodcut letters that feel carved," "delicate cursive that looks like it might blow away," "bold condensed industrial stencil," "playful hand-drawn with slight imperfections." The title font and author font should feel like they belong to the same world but play different roles.

6. MOOD IN ONE SENTENCE: If this cover were a feeling, what would it be? (e.g., "The hush before a thunderstorm" or "Finding a secret door in a familiar room")

Return ONLY a JSON object:
{
  "art_style": "specific style + why it fits",
  "color_palette": ["color1", "color2", "color3", "color4"],
  "palette_mood": "what mood the colors create",
  "central_image": "the single most powerful image concept",
  "composition": "where the eye goes, visual hierarchy, use of space",
  "title_typography": "personality of the title lettering",
  "author_typography": "personality of the author name lettering",
  "mood": "the cover as a feeling in one sentence"
}`;

  try {
    const startTime = Date.now();
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: briefPrompt }]
    });

    const elapsed = Date.now() - startTime;
    const text = response.content[0]?.text || '';
    console.log(`🎨 Art director brief generated in ${elapsed}ms (${text.length} chars)`);

    // Parse the JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('🎨 Art director returned non-JSON, falling back to template');
      return null;
    }

    const brief = JSON.parse(jsonMatch[0]);

    // Log the cost (Sonnet is cheap — ~$0.003 per brief)
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;

    return brief;
  } catch (error) {
    console.warn(`🎨 Art director brief failed (non-fatal): ${error.message}`);
    return null; // Fall back to template-based prompt
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

  // Step 0: Get creative brief from Claude art director
  const creativeBrief = await generateCoverCreativeBrief(title, genre, bible);

  // Step 1: Generate the image with OpenAI using the creative brief
  const prompt = creativeBrief
    ? buildCoverPromptFromBrief(title, authorName, creativeBrief)
    : buildCoverPromptFallback(title, genre, bible, authorName);

  console.log(`🎨 Using ${creativeBrief ? 'art-directed' : 'template fallback'} cover prompt`);

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
      quality: 'high',
      art_directed: !!creativeBrief
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
 * Build cover prompt from Claude's creative brief — the art-directed path.
 */
function buildCoverPromptFromBrief(title, authorName, brief) {
  const spelledTitle = spellOutTitle(title);
  const upperTitle = title.toUpperCase();
  const upperAuthor = authorName.toUpperCase();

  return `Create a book cover with these EXACT art direction specifications:

ART STYLE: ${brief.art_style}

COLOR PALETTE: ${brief.color_palette?.join(', ') || 'vibrant and genre-appropriate'}
Palette mood: ${brief.palette_mood || ''}

CENTRAL IMAGE: ${brief.central_image}

COMPOSITION: ${brief.composition}

Overall mood: ${brief.mood || ''}

TEXT LAYOUT:
Title: "${upperTitle}" — spelled ${spelledTitle} — placed prominently.
Title typography: ${brief.title_typography}
Author: "${upperAuthor}" in smaller type at the bottom.
Author typography: ${brief.author_typography}

HARD REQUIREMENTS (non-negotiable):
- Flat, front-facing rectangular artwork filling the entire canvas edge-to-edge
- Strong contrast between text and background — text MUST be perfectly legible
- All text spelled correctly with no extra characters
- Do NOT render a 3D book object, spine, or pages
- No borders or margins
- Include padding so no text is cut off at edges`;
}

/**
 * Fallback cover prompt when art director brief fails — uses the old template approach.
 */
function buildCoverPromptFallback(title, genre, bible, authorName) {
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

ART STYLE:
You are designing a book cover for a ${genre} novel. Based on the genre, themes, setting, and characters described above, choose an art style, color palette, and composition that would make this book visually compelling and distinct on a bookshelf. Consider what readers of this genre expect to see on a cover, then add something unexpected.

The cover must be vibrant and inviting. Do not default to dark, muddy, or overly moody palettes unless the story genuinely demands it (e.g., horror, gothic). Every cover in a reader's library should look different from every other cover — avoid a uniform "look."

TEXT LAYOUT:
At the top: "${upperTitle}" — spelled ${spelledTitle} — in bold, genre-appropriate display font, large and centered, with strong contrast against the background.
At the bottom: "${upperAuthor}" in smaller clean font, centered.

REQUIREMENTS:
- Flat, front-facing rectangular artwork filling the entire canvas edge-to-edge
- Vibrant, eye-catching color palette appropriate to the genre — covers should be visually striking and inviting, not muddy or overly dark
- Strong contrast between text and background for readability
- All text perfectly legible with no extra characters
- Do NOT render a 3D book object, spine, or pages
- No borders or margins
- Include padding so no text is cut off`;
}

module.exports = {
  generateBookCover,
  buildCoverPromptFromBrief,
  buildCoverPromptFallback,
  generateCoverCreativeBrief
};
