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

  return `Design a professional, published-quality book cover for a ${genre} novel.

Title: "${title}"
Author name: "${authorName}"

Story summary: ${description}
Themes: ${themeStr}

Requirements:
- This must look like a real, professionally designed book cover you'd find in a bookstore
- The title "${title}" must be prominently displayed and perfectly legible
- The author name "${authorName}" must appear on the cover (typically at top or bottom)
- Genre-appropriate artwork and color palette for ${genre}
- Rich, detailed illustration or photographic composition as the cover art
- Professional typography — the text must be crisp, clean, and correctly spelled
- Include subtle decorative elements appropriate to the genre (ornamental borders, textures, etc.)
- The overall composition should have visual depth and feel premium
- Portrait orientation (taller than wide), standard book cover proportions
- Do NOT include any publisher logos, barcodes, or ISBN numbers`;
}

module.exports = {
  generateBookCover,
  buildCoverPrompt
};
