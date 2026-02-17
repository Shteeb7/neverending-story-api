const { buildCoverPrompt, getArtStyle } = require('../src/services/cover-generation');

describe('Cover Generation - getArtStyle', () => {
  test('returns digital fantasy art style for LitRPG genre', () => {
    const style = getArtStyle('LitRPG Adventure');
    expect(style).toContain('digital fantasy art');
    expect(style).toContain('glowing UI elements');
  });

  test('returns sleek sci-fi style for sci-fi genre', () => {
    const style = getArtStyle('Sci-Fi Thriller');
    expect(style).toContain('sci-fi concept art');
    expect(style).toContain('neon accents');
  });

  test('returns dark gothic style for horror genre', () => {
    const style = getArtStyle('Gothic Horror');
    expect(style).toContain('dark gothic');
    expect(style).toContain('crimson');
  });

  test('returns whimsical watercolor style for whimsical genre', () => {
    const style = getArtStyle('Whimsical Fantasy');
    expect(style).toContain('whimsical watercolor');
    expect(style).toContain('warm golden tones');
  });

  test('returns heroic oil painting style for heroic genre', () => {
    const style = getArtStyle('Heroic Fantasy');
    expect(style).toContain('oil painting');
    expect(style).toContain('heroic composition');
  });

  test('returns default style for unknown genre', () => {
    const style = getArtStyle('Unknown Genre');
    expect(style).toContain('richly detailed book cover');
    expect(style).toContain('vibrant color palette');
  });

  test('returns default style for null genre', () => {
    const style = getArtStyle(null);
    expect(style).toContain('richly detailed book cover');
  });

  test('returns default style for undefined genre', () => {
    const style = getArtStyle(undefined);
    expect(style).toContain('richly detailed book cover');
  });

  test('returns distinct styles for different genres', () => {
    const litrpg = getArtStyle('LitRPG');
    const scifi = getArtStyle('Sci-Fi');
    const horror = getArtStyle('Horror');
    const romance = getArtStyle('Romance');

    // Each style should be unique
    expect(litrpg).not.toBe(scifi);
    expect(scifi).not.toBe(horror);
    expect(horror).not.toBe(romance);
    expect(romance).not.toBe(litrpg);
  });
});

describe('Cover Generation - buildCoverPrompt', () => {
  const mockBibleFull = {
    characters: [
      {
        name: 'Elara Moonwhisper',
        appearance: 'tall elven ranger with silver hair and emerald eyes',
        description: 'A skilled archer from the Moonwood'
      }
    ],
    key_locations: [
      {
        name: 'The Shattered Spire',
        description: 'an ancient tower split in half by dark magic, crackling with residual energy'
      }
    ],
    central_conflict: {
      description: 'Elara must prevent the resurrection of the Shadow King before the eclipse'
    },
    themes: ['redemption', 'sacrifice', 'hope']
  };

  test('includes protagonist name when present in bible', () => {
    const prompt = buildCoverPrompt('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    expect(prompt).toContain('Elara Moonwhisper');
  });

  test('includes protagonist appearance when present in bible', () => {
    const prompt = buildCoverPrompt('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    expect(prompt).toContain('silver hair');
    expect(prompt).toContain('emerald eyes');
  });

  test('includes primary location when present in bible', () => {
    const prompt = buildCoverPrompt('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    expect(prompt).toContain('The Shattered Spire');
    expect(prompt).toContain('ancient tower');
  });

  test('includes central conflict when present in bible', () => {
    const prompt = buildCoverPrompt('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    expect(prompt).toContain('Shadow King');
    expect(prompt).toContain('eclipse');
  });

  test('includes themes when present in bible', () => {
    const prompt = buildCoverPrompt('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    expect(prompt).toContain('redemption');
    expect(prompt).toContain('sacrifice');
    expect(prompt).toContain('hope');
  });

  test('includes genre-appropriate art style', () => {
    const prompt = buildCoverPrompt('Shadow Rising', 'LitRPG', mockBibleFull, 'John Doe');
    expect(prompt).toContain('digital fantasy art');
  });

  test('includes title in uppercase', () => {
    const prompt = buildCoverPrompt('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    expect(prompt).toContain('SHADOW RISING');
  });

  test('includes author name in uppercase', () => {
    const prompt = buildCoverPrompt('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    expect(prompt).toContain('JOHN DOE');
  });

  test('handles null bible gracefully without crashing', () => {
    expect(() => {
      buildCoverPrompt('Shadow Rising', 'Fantasy', null, 'John Doe');
    }).not.toThrow();
  });

  test('handles undefined bible gracefully without crashing', () => {
    expect(() => {
      buildCoverPrompt('Shadow Rising', 'Fantasy', undefined, 'John Doe');
    }).not.toThrow();
  });

  test('handles empty bible object gracefully', () => {
    expect(() => {
      buildCoverPrompt('Shadow Rising', 'Fantasy', {}, 'John Doe');
    }).not.toThrow();
  });

  test('handles bible with null characters array', () => {
    const bibleNoCharacters = { ...mockBibleFull, characters: null };
    expect(() => {
      buildCoverPrompt('Shadow Rising', 'Fantasy', bibleNoCharacters, 'John Doe');
    }).not.toThrow();
  });

  test('handles bible with empty characters array', () => {
    const bibleNoCharacters = { ...mockBibleFull, characters: [] };
    const prompt = buildCoverPrompt('Shadow Rising', 'Fantasy', bibleNoCharacters, 'John Doe');
    expect(prompt).toBeTruthy();
  });

  test('handles bible with null locations array', () => {
    const bibleNoLocations = { ...mockBibleFull, key_locations: null };
    expect(() => {
      buildCoverPrompt('Shadow Rising', 'Fantasy', bibleNoLocations, 'John Doe');
    }).not.toThrow();
  });

  test('handles bible with empty locations array', () => {
    const bibleNoLocations = { ...mockBibleFull, key_locations: [] };
    const prompt = buildCoverPrompt('Shadow Rising', 'Fantasy', bibleNoLocations, 'John Doe');
    expect(prompt).toBeTruthy();
  });

  test('handles bible with string central_conflict', () => {
    const bibleStringConflict = {
      ...mockBibleFull,
      central_conflict: 'A simple conflict description'
    };
    const prompt = buildCoverPrompt('Shadow Rising', 'Fantasy', bibleStringConflict, 'John Doe');
    expect(prompt).toContain('simple conflict');
  });

  test('handles bible with null central_conflict', () => {
    const bibleNoConflict = { ...mockBibleFull, central_conflict: null };
    expect(() => {
      buildCoverPrompt('Shadow Rising', 'Fantasy', bibleNoConflict, 'John Doe');
    }).not.toThrow();
  });

  test('handles bible with themes as array', () => {
    const prompt = buildCoverPrompt('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    expect(prompt).toContain('redemption');
  });

  test('handles bible with themes as string', () => {
    const bibleStringThemes = { ...mockBibleFull, themes: 'courage and honor' };
    const prompt = buildCoverPrompt('Shadow Rising', 'Fantasy', bibleStringThemes, 'John Doe');
    expect(prompt).toContain('courage and honor');
  });

  test('handles bible with null themes', () => {
    const bibleNoThemes = { ...mockBibleFull, themes: null };
    expect(() => {
      buildCoverPrompt('Shadow Rising', 'Fantasy', bibleNoThemes, 'John Doe');
    }).not.toThrow();
  });

  test('returns different prompts for different genres', () => {
    const fantasyPrompt = buildCoverPrompt('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    const litrpgPrompt = buildCoverPrompt('Shadow Rising', 'LitRPG', mockBibleFull, 'John Doe');
    const scifiPrompt = buildCoverPrompt('Shadow Rising', 'Sci-Fi', mockBibleFull, 'John Doe');

    // Each prompt should have different art styles
    expect(fantasyPrompt).not.toContain('digital fantasy art');
    expect(litrpgPrompt).toContain('digital fantasy art');
    expect(scifiPrompt).toContain('sci-fi concept art');
  });

  test('prompt includes requirements section', () => {
    const prompt = buildCoverPrompt('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    expect(prompt).toContain('REQUIREMENTS');
    expect(prompt).toContain('edge-to-edge');
    expect(prompt).toContain('Do NOT render a 3D book object');
  });

  test('prompt includes text layout section', () => {
    const prompt = buildCoverPrompt('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    expect(prompt).toContain('TEXT LAYOUT');
    expect(prompt).toContain('At the top');
    expect(prompt).toContain('At the bottom');
  });

  test('prompt includes visual scene section', () => {
    const prompt = buildCoverPrompt('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    expect(prompt).toContain('VISUAL SCENE');
  });
});
