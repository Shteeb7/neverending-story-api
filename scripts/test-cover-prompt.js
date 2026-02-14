require('dotenv').config();
const OpenAI = require('openai');
const fs = require('fs');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const prompt = `A book cover illustration. Flat, front-facing rectangular artwork filling the entire canvas edge-to-edge.

At the top, the title reads "RESPAWN: NORMANDY" — spelled R-E-S-P-A-W-N colon N-O-R-M-A-N-D-Y — in bold serif font, large and centered, white or metallic lettering with dramatic shadow.

At the bottom, the author name reads "STEVEN" in smaller clean sans-serif font, white, centered.

Background artwork: A young WWII soldier on Omaha Beach at dawn, caught between two worlds. Translucent green video game HUD elements and holographic UI overlays flicker around him. Landing craft, explosions, soldiers storming the beach behind him. American flag imagery. Dark dramatic lighting — deep reds, military greens, steel grays. Rich, painterly, cinematic composition.

Ensure all text is perfectly legible with no extra characters. Do NOT render a 3D book object, spine, or pages. No borders or margins. Include padding so no text is cut off.`;

async function testCover() {
  console.log('Generating test cover with movie-poster prompt...');

  const response = await openai.images.generate({
    model: 'gpt-image-1',
    prompt: prompt,
    size: '1024x1536',
    quality: 'high',
  });

  const b64_json = response.data[0].b64_json;
  console.log('Generated image (base64)');
  console.log('Revised prompt:', response.data[0].revised_prompt || 'N/A');

  // Decode base64 and save
  const buffer = Buffer.from(b64_json, 'base64');
  fs.writeFileSync('test-cover-respawn.png', buffer);
  console.log('Saved to test-cover-respawn.png');
}

testCover().catch(console.error);
