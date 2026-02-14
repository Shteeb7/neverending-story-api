const { openai } = require('../config/ai-clients');
const { supabaseAdmin } = require('../config/supabase');

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
 * @param {object} storyDetails - { title, genre, themes, description }
 * @param {string} authorName - Reader's name to display as author
 * @returns {string} Public URL of the stored cover image
 */
async function generateBookCover(storyId, storyDetails, authorName) {
  const { title, genre, themes, description } = storyDetails;

  console.log(`🎨 Generating cover for "${title}" by ${authorName}`);

  // Ensure the storage bucket exists
  await ensureBucketExists();

  // Step 1: Generate the image with OpenAI
  const prompt = buildCoverPrompt(title, genre, themes, description, authorName);

  const response = await openai.images.generate({
    model: 'dall-e-3',
    prompt: prompt,
    n: 1,
    size: '1024x1792', // Portrait aspect ratio for book covers (dall-e-3 supports 1024x1792)
    quality: 'standard' // dall-e-3 uses 'standard' or 'hd', not 'medium'
  });

  const imageUrl = response.data[0].url;

  if (!imageUrl) {
    throw new Error('OpenAI returned no image URL');
  }

  // Step 2: Download the image from OpenAI's temporary URL
  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) {
    throw new Error(`Failed to download generated image: ${imageResponse.status}`);
  }
  const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

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
 * Build the OpenAI image generation prompt for a book cover.
 */
function buildCoverPrompt(title, genre, themes, description, authorName) {
  const themeStr = Array.isArray(themes) ? themes.join(', ') : (themes || '');

  return `Create a flat, front-facing book cover illustration for a ${genre} novel. This is NOT an image of a physical book — it is the cover artwork itself, as if scanned flat on a table.

Title: "${title}"
Author: "${authorName}"

Story: ${description}
Themes: ${themeStr}

CRITICAL RULES:
- This is a FLAT, 2D, front-facing rectangular image — NO 3D perspective, NO book spine, NO visible pages, NO curled edges, NO shadow of a book object
- Think of this as the artwork file a designer would send to the printer — perfectly flat and rectangular
- The title "${title}" must be rendered in LARGE, BOLD, HIGHLY LEGIBLE typography — treat the text as the most important element
- The author name "${authorName}" should appear smaller, typically at the top or bottom
- ALL TEXT must be spelled exactly as provided — double-check every letter
- Use clean, professional font styling — no distorted, warped, or stylized letterforms that sacrifice readability
- Genre-appropriate illustration or painterly composition for ${genre}
- Rich color palette that fits the genre and mood
- Professional layout with clear visual hierarchy: artwork, title, author name
- Portrait orientation (taller than wide)
- Do NOT include publisher logos, barcodes, ISBN numbers, or review quotes
- Do NOT render this as a photograph of a book — it must be the flat cover art only`;
}

module.exports = {
  generateBookCover,
  buildCoverPrompt
};
