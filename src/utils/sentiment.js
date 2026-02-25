/**
 * Sentiment Detection Utility
 * Maps Resonance words to sentiment categories for analytics
 */

const SENTIMENT_MAP = {
  // Positive words
  hope: 'positive',
  joy: 'positive',
  wonder: 'positive',
  courage: 'positive',
  tenderness: 'positive',
  warmth: 'positive',
  triumph: 'positive',
  peace: 'positive',

  // Negative words
  longing: 'negative',
  melancholy: 'negative',
  unease: 'negative',
  fury: 'negative',
  grief: 'negative',
  sorrow: 'negative',
  dread: 'negative',

  // Neutral/Mixed words
  defiance: 'mixed',
  surprise: 'mixed',
  awe: 'mixed',
  nostalgia: 'mixed',
  bittersweet: 'mixed'
};

/**
 * Detects sentiment for a Resonance word
 * @param {string} word - The Resonance word (e.g., "hope", "melancholy")
 * @returns {string} - Sentiment: 'positive', 'negative', 'mixed', or 'neutral'
 */
function sentimentForWord(word) {
  if (!word) return 'neutral';

  const normalizedWord = word.toLowerCase().trim();

  // Check if word is in our curated list
  if (SENTIMENT_MAP[normalizedWord]) {
    return SENTIMENT_MAP[normalizedWord];
  }

  // Custom words default to 'neutral'
  return 'neutral';
}

module.exports = {
  sentimentForWord
};
