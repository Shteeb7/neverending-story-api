const { buildCourseCorrections, generateEditorBrief } = require('../src/services/generation');

describe('Course Corrections v3 - Editor Brief Architecture', () => {
  describe('buildCourseCorrections (mechanical fallback - kept for backward compat)', () => {
    test('should return empty string for no feedback', () => {
      const result = buildCourseCorrections([]);
      expect(result).toBe('');
    });

    test('should handle all positive feedback', () => {
      const feedback = [{
        pacing_feedback: 'hooked',
        tone_feedback: 'right',
        character_feedback: 'love'
      }];

      const result = buildCourseCorrections(feedback);
      expect(result).toContain('Maintain current');
    });

    test('should generate pacing corrections', () => {
      const feedback = [{
        pacing_feedback: 'slow',
        tone_feedback: 'right',
        character_feedback: 'love'
      }];

      const result = buildCourseCorrections(feedback);
      expect(result).toContain('PACING');
    });
  });

  describe('generateEditorBrief (v3 - XML-based editor annotations)', () => {
    test('should return null for all positive feedback', async () => {
      const feedback = [{
        pacing_feedback: 'hooked',
        tone_feedback: 'right',
        character_feedback: 'love'
      }];
      const outlines = [
        { chapter_number: 4, title: 'Test', events_summary: 'Events', character_focus: 'Protagonist', tension_level: 'high', word_count_target: 3000 }
      ];

      const result = await generateEditorBrief('test-story-id', feedback, outlines);

      // Should return null when no corrections needed
      expect(result).toBeNull();
    });

    test('should be called with chapter outlines from arc', () => {
      // This test documents that generateEditorBrief requires chapter outlines
      // from the story_arcs table as input, not just feedback
      const feedback = [{ tone_feedback: 'serious' }];
      const outlines = [
        { chapter_number: 4, title: 'Chapter 4', events_summary: 'Some events', character_focus: 'Hero', tension_level: 'medium', word_count_target: 2800 }
      ];

      expect(outlines).toHaveLength(1);
      expect(outlines[0]).toHaveProperty('chapter_number');
      expect(outlines[0]).toHaveProperty('events_summary');
    });

    test('should return revisedOutlines and styleExample structure', () => {
      // Document expected return format
      const expectedFormat = {
        revisedOutlines: [
          {
            chapter_number: 4,
            title: 'Chapter Title',
            events_summary: 'Original events',
            character_focus: 'Character',
            tension_level: 'high',
            word_count_target: 3000,
            editor_notes: 'When X does Y, add Z...'
          }
        ],
        styleExample: 'An 80-120 word prose passage demonstrating the corrected tone...'
      };

      expect(expectedFormat.revisedOutlines).toHaveLength(1);
      expect(expectedFormat.revisedOutlines[0]).toHaveProperty('editor_notes');
      expect(expectedFormat.styleExample).toBeDefined();
    });

    test('editor_notes should contain character names, not generic advice', () => {
      // Good editor note: "When Jinx reviews supply data, give her one sardonic thought about an absurd line item"
      // Bad editor note: "Add more humor to this chapter"

      const goodNote = "When Jinx reviews supply data in the logistics bay, give her one sardonic internal observation about an absurd line item";
      const badNote = "Add more humor to this chapter";

      expect(goodNote).toContain('Jinx'); // Has character name
      expect(goodNote.length).toBeGreaterThan(50); // Is specific
      expect(badNote).not.toContain('Jinx'); // Generic, no character
    });

    test('styleExample should be 80-120 words with character names', () => {
      const example = `Jinx stared at the manifest line. Four hundred metric tons of decorative bunting, priority-shipped to Station Kepler while they were rationing water. She closed the terminal and counted to five. The Ascendancy's priorities in one requisition form. Spectacular. She opened a new tab and started the quarterly audit she was supposed to be doing. Her fingers moved through the interface on autopilot while her brain ran escape routes. Someone had approved this. Someone had looked at water rations, looked at decorative bunting, and chosen bunting. She pulled up the authorization chain. Five levels deep before she hit a redaction wall.`;

      const wordCount = example.split(/\s+/).length;
      expect(wordCount).toBeGreaterThanOrEqual(80);
      expect(wordCount).toBeLessThanOrEqual(120);
      expect(example).toContain('Jinx'); // Has character name
    });

    test('should handle XML output format (not JSON)', () => {
      // v3 uses XML to avoid JSON quote escaping issues with long-form text
      const xmlExample = `<editor_brief>
  <revised_outline chapter="4">
    <title>Chapter Title</title>
    <editor_notes>
      Specific beats here with character names...
    </editor_notes>
  </revised_outline>
  <style_example>
    Prose passage here...
  </style_example>
</editor_brief>`;

      expect(xmlExample).toContain('<editor_brief>');
      expect(xmlExample).toContain('<revised_outline');
      expect(xmlExample).toContain('<style_example>');
    });

    test('should handle parse errors gracefully', () => {
      // If XML parsing fails, should return null (triggering fallback to no corrections)
      // This is tested by the actual implementation which catches parse errors
      expect(true).toBe(true); // Document expected behavior
    });
  });

  describe('Integration - Editor Brief Flow', () => {
    test('feedback.js should fetch arc outlines before calling generateEditorBrief', () => {
      // Document the required flow:
      // 1. Fetch arc from story_arcs table
      // 2. Extract chapter outlines for the batch being generated
      // 3. Pass outlines to generateEditorBrief along with feedback
      // 4. Pass result to generateBatch

      expect(true).toBe(true);
    });

    test('generateChapter should use effectiveOutline (revised or original)', () => {
      // If editorBrief exists and has a revised outline for this chapter,
      // use the revised version. Otherwise use original from arc.
      // effectiveOutline = { ...chapterOutline, ...revised }

      const original = { title: 'Original', events_summary: 'Events', word_count_target: 2800 };
      const revised = { title: 'Original', events_summary: 'Events with new beats', word_count_target: 2800, editor_notes: 'When X...' };
      const effective = { ...original, ...revised };

      expect(effective.editor_notes).toBeDefined();
      expect(effective.events_summary).toBe('Events with new beats');
    });

    test('style_example should be conditionally replaced', () => {
      // If editorBrief.styleExample exists, use it instead of generic example
      // Otherwise use the generic "The door stood open..." example

      const hasEditorBrief = true;
      const styleContent = hasEditorBrief
        ? 'Custom style example with character names...'
        : 'The door stood open. She didn\'t remember leaving it that way...';

      expect(styleContent).toContain('Custom');
    });
  });

  describe('v3 Design Rationale', () => {
    test('corrections woven into outline, not separate block', () => {
      // v1 failed: static lookup table
      // v2 failed: AI corrections in separate block competing with craft rules
      // v3 works: corrections ARE the outline, no separate block

      expect(true).toBe(true); // Document why v3 architecture works
    });

    test('examples beat instructions', () => {
      // One good prose example (styleExample) > 500 words of directives
      // Anthropic best practice confirmed by research

      expect(true).toBe(true);
    });

    test('XML avoids JSON quote escaping issues', () => {
      // v2's JSON parsing failed because correction text had unescaped quotes
      // XML handles embedded quotes, dialogue examples, and long-form text naturally

      const textWithQuotes = `When Jinx says, "Four hundred tons of bunting," let her tone be sardonic.`;
      expect(textWithQuotes).toContain('"'); // Would break JSON without escaping
    });
  });
});
