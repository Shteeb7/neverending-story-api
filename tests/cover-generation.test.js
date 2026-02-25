const { buildCoverPromptFallback, buildCoverPromptFromBrief, generateCoverCreativeBrief } = require('../src/services/cover-generation');

describe('Cover Generation - buildCoverPromptFallback (template path)', () => {
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
    const prompt = buildCoverPromptFallback('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    expect(prompt).toContain('Elara Moonwhisper');
  });

  test('includes protagonist appearance when present in bible', () => {
    const prompt = buildCoverPromptFallback('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    expect(prompt).toContain('silver hair');
    expect(prompt).toContain('emerald eyes');
  });

  test('includes primary location when present in bible', () => {
    const prompt = buildCoverPromptFallback('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    expect(prompt).toContain('The Shattered Spire');
    expect(prompt).toContain('ancient tower');
  });

  test('includes central conflict when present in bible', () => {
    const prompt = buildCoverPromptFallback('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    expect(prompt).toContain('Shadow King');
    expect(prompt).toContain('eclipse');
  });

  test('includes themes when present in bible', () => {
    const prompt = buildCoverPromptFallback('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    expect(prompt).toContain('redemption');
    expect(prompt).toContain('sacrifice');
    expect(prompt).toContain('hope');
  });

  test('includes AI-driven art style instructions', () => {
    const prompt = buildCoverPromptFallback('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    expect(prompt).toContain('You are designing a book cover');
    expect(prompt).toContain('choose an art style, color palette, and composition');
    expect(prompt).toContain('vibrant and inviting');
  });

  test('includes title in uppercase', () => {
    const prompt = buildCoverPromptFallback('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    expect(prompt).toContain('SHADOW RISING');
  });

  test('includes author name in uppercase', () => {
    const prompt = buildCoverPromptFallback('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    expect(prompt).toContain('JOHN DOE');
  });

  test('handles null bible gracefully without crashing', () => {
    expect(() => {
      buildCoverPromptFallback('Shadow Rising', 'Fantasy', null, 'John Doe');
    }).not.toThrow();
  });

  test('handles undefined bible gracefully without crashing', () => {
    expect(() => {
      buildCoverPromptFallback('Shadow Rising', 'Fantasy', undefined, 'John Doe');
    }).not.toThrow();
  });

  test('handles empty bible object gracefully', () => {
    expect(() => {
      buildCoverPromptFallback('Shadow Rising', 'Fantasy', {}, 'John Doe');
    }).not.toThrow();
  });

  test('handles bible with null characters array', () => {
    const bibleNoCharacters = { ...mockBibleFull, characters: null };
    expect(() => {
      buildCoverPromptFallback('Shadow Rising', 'Fantasy', bibleNoCharacters, 'John Doe');
    }).not.toThrow();
  });

  test('handles bible with empty characters array', () => {
    const bibleNoCharacters = { ...mockBibleFull, characters: [] };
    const prompt = buildCoverPromptFallback('Shadow Rising', 'Fantasy', bibleNoCharacters, 'John Doe');
    expect(prompt).toBeTruthy();
  });

  test('handles bible with null locations array', () => {
    const bibleNoLocations = { ...mockBibleFull, key_locations: null };
    expect(() => {
      buildCoverPromptFallback('Shadow Rising', 'Fantasy', bibleNoLocations, 'John Doe');
    }).not.toThrow();
  });

  test('handles bible with empty locations array', () => {
    const bibleNoLocations = { ...mockBibleFull, key_locations: [] };
    const prompt = buildCoverPromptFallback('Shadow Rising', 'Fantasy', bibleNoLocations, 'John Doe');
    expect(prompt).toBeTruthy();
  });

  test('handles bible with string central_conflict', () => {
    const bibleStringConflict = {
      ...mockBibleFull,
      central_conflict: 'A simple conflict description'
    };
    const prompt = buildCoverPromptFallback('Shadow Rising', 'Fantasy', bibleStringConflict, 'John Doe');
    expect(prompt).toContain('simple conflict');
  });

  test('handles bible with null central_conflict', () => {
    const bibleNoConflict = { ...mockBibleFull, central_conflict: null };
    expect(() => {
      buildCoverPromptFallback('Shadow Rising', 'Fantasy', bibleNoConflict, 'John Doe');
    }).not.toThrow();
  });

  test('handles bible with themes as array', () => {
    const prompt = buildCoverPromptFallback('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    expect(prompt).toContain('redemption');
  });

  test('handles bible with themes as string', () => {
    const bibleStringThemes = { ...mockBibleFull, themes: 'courage and honor' };
    const prompt = buildCoverPromptFallback('Shadow Rising', 'Fantasy', bibleStringThemes, 'John Doe');
    expect(prompt).toContain('courage and honor');
  });

  test('handles bible with null themes', () => {
    const bibleNoThemes = { ...mockBibleFull, themes: null };
    expect(() => {
      buildCoverPromptFallback('Shadow Rising', 'Fantasy', bibleNoThemes, 'John Doe');
    }).not.toThrow();
  });

  test('includes genre in prompt for AI to consider', () => {
    const fantasyPrompt = buildCoverPromptFallback('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    const litrpgPrompt = buildCoverPromptFallback('Shadow Rising', 'LitRPG', mockBibleFull, 'John Doe');
    const scifiPrompt = buildCoverPromptFallback('Shadow Rising', 'Sci-Fi', mockBibleFull, 'John Doe');

    // Each prompt should mention its genre
    expect(fantasyPrompt).toContain('Fantasy novel');
    expect(litrpgPrompt).toContain('LitRPG novel');
    expect(scifiPrompt).toContain('Sci-Fi novel');

    // All should have the AI art style selection instructions
    expect(fantasyPrompt).toContain('You are designing a book cover');
    expect(litrpgPrompt).toContain('You are designing a book cover');
    expect(scifiPrompt).toContain('You are designing a book cover');
  });

  test('prompt includes requirements section', () => {
    const prompt = buildCoverPromptFallback('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    expect(prompt).toContain('REQUIREMENTS');
    expect(prompt).toContain('edge-to-edge');
    expect(prompt).toContain('Do NOT render a 3D book object');
  });

  test('prompt includes text layout section', () => {
    const prompt = buildCoverPromptFallback('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    expect(prompt).toContain('TEXT LAYOUT');
    expect(prompt).toContain('At the top');
    expect(prompt).toContain('At the bottom');
  });

  test('prompt includes visual scene section', () => {
    const prompt = buildCoverPromptFallback('Shadow Rising', 'Fantasy', mockBibleFull, 'John Doe');
    expect(prompt).toContain('VISUAL SCENE');
  });
});

describe('Cover Generation - buildCoverPromptFromBrief (art-directed path)', () => {
  const mockBrief = {
    art_style: 'Gouache painting with visible brushstrokes — warm and tactile, like a hand-painted movie poster from the 1970s',
    color_palette: ['burnt sienna', 'midnight blue', 'warm gold', 'ivory'],
    palette_mood: 'Nostalgic warmth with an undercurrent of danger',
    central_image: 'A cracked hourglass with sand flowing upward, suspended over a city skyline at dusk',
    composition: 'Hourglass dominates the center, city stretches across the bottom third. Title arcs across the top. Eye goes to the crack first, then follows the upward sand.',
    title_typography: 'Hand-lettered with slightly uneven baseline, as if painted with a confident but imperfect brush — warm gold with subtle shadow',
    author_typography: 'Simple clean sans-serif in ivory, understated against the rich background',
    mood: 'The moment you realize time has been running backward all along'
  };

  test('includes art style from brief', () => {
    const prompt = buildCoverPromptFromBrief('The Hourglass Reversal', 'Jane Smith', mockBrief);
    expect(prompt).toContain('Gouache painting');
    expect(prompt).toContain('hand-painted movie poster');
  });

  test('includes color palette from brief', () => {
    const prompt = buildCoverPromptFromBrief('The Hourglass Reversal', 'Jane Smith', mockBrief);
    expect(prompt).toContain('burnt sienna');
    expect(prompt).toContain('midnight blue');
  });

  test('includes central image concept from brief', () => {
    const prompt = buildCoverPromptFromBrief('The Hourglass Reversal', 'Jane Smith', mockBrief);
    expect(prompt).toContain('cracked hourglass');
    expect(prompt).toContain('sand flowing upward');
  });

  test('includes composition direction from brief', () => {
    const prompt = buildCoverPromptFromBrief('The Hourglass Reversal', 'Jane Smith', mockBrief);
    expect(prompt).toContain('Hourglass dominates the center');
  });

  test('includes typography personality from brief', () => {
    const prompt = buildCoverPromptFromBrief('The Hourglass Reversal', 'Jane Smith', mockBrief);
    expect(prompt).toContain('Hand-lettered');
    expect(prompt).toContain('Simple clean sans-serif');
  });

  test('includes title in uppercase', () => {
    const prompt = buildCoverPromptFromBrief('The Hourglass Reversal', 'Jane Smith', mockBrief);
    expect(prompt).toContain('THE HOURGLASS REVERSAL');
  });

  test('includes author in uppercase', () => {
    const prompt = buildCoverPromptFromBrief('The Hourglass Reversal', 'Jane Smith', mockBrief);
    expect(prompt).toContain('JANE SMITH');
  });

  test('includes hard requirements', () => {
    const prompt = buildCoverPromptFromBrief('The Hourglass Reversal', 'Jane Smith', mockBrief);
    expect(prompt).toContain('edge-to-edge');
    expect(prompt).toContain('Do NOT render a 3D book object');
    expect(prompt).toContain('text MUST be perfectly legible');
  });

  test('includes mood from brief', () => {
    const prompt = buildCoverPromptFromBrief('The Hourglass Reversal', 'Jane Smith', mockBrief);
    expect(prompt).toContain('time has been running backward');
  });

  test('handles brief with missing optional fields gracefully', () => {
    const minimalBrief = {
      art_style: 'Watercolor',
      central_image: 'A lone tree',
      composition: 'Centered'
    };
    expect(() => {
      buildCoverPromptFromBrief('Test Title', 'Test Author', minimalBrief);
    }).not.toThrow();
    const prompt = buildCoverPromptFromBrief('Test Title', 'Test Author', minimalBrief);
    expect(prompt).toContain('Watercolor');
    expect(prompt).toContain('lone tree');
  });
});
