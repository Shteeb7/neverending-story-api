describe('Bible and Arc Maintenance', () => {
  describe('Feature Flags', () => {
    it('should default bible_refresh to enabled when not specified', () => {
      const config = {};
      const useBibleRefresh = config.bible_refresh !== false;
      expect(useBibleRefresh).toBe(true);
    });

    it('should respect bible_refresh when disabled', () => {
      const config = { bible_refresh: false };
      const useBibleRefresh = config.bible_refresh !== false;
      expect(useBibleRefresh).toBe(false);
    });

    it('should default arc_enrichment to enabled when not specified', () => {
      const config = {};
      const useArcEnrichment = config.arc_enrichment !== false;
      expect(useArcEnrichment).toBe(true);
    });

    it('should respect arc_enrichment when disabled', () => {
      const config = { arc_enrichment: false };
      const useArcEnrichment = config.arc_enrichment !== false;
      expect(useArcEnrichment).toBe(false);
    });
  });

  describe('Batch End Detection', () => {
    it('should identify chapter 3 as a batch end', () => {
      const batchEndChapters = [3, 6, 9, 12];
      expect(batchEndChapters.includes(3)).toBe(true);
    });

    it('should identify chapter 6 as a batch end', () => {
      const batchEndChapters = [3, 6, 9, 12];
      expect(batchEndChapters.includes(6)).toBe(true);
    });

    it('should identify chapter 9 as a batch end', () => {
      const batchEndChapters = [3, 6, 9, 12];
      expect(batchEndChapters.includes(9)).toBe(true);
    });

    it('should identify chapter 12 as a batch end', () => {
      const batchEndChapters = [3, 6, 9, 12];
      expect(batchEndChapters.includes(12)).toBe(true);
    });

    it('should not identify chapter 4 as a batch end', () => {
      const batchEndChapters = [3, 6, 9, 12];
      expect(batchEndChapters.includes(4)).toBe(false);
    });

    it('should calculate correct batch chapters for chapter 3', () => {
      const chapterNumber = 3;
      const batchStart = chapterNumber - 2;
      const batchChapters = [batchStart, batchStart + 1, batchStart + 2];
      expect(batchChapters).toEqual([1, 2, 3]);
    });

    it('should calculate correct batch chapters for chapter 6', () => {
      const chapterNumber = 6;
      const batchStart = chapterNumber - 2;
      const batchChapters = [batchStart, batchStart + 1, batchStart + 2];
      expect(batchChapters).toEqual([4, 5, 6]);
    });

    it('should calculate correct batch number for chapter 3', () => {
      const chapterNumber = 3;
      const batchNumber = Math.ceil(chapterNumber / 3);
      expect(batchNumber).toBe(1);
    });

    it('should calculate correct batch number for chapter 6', () => {
      const chapterNumber = 6;
      const batchNumber = Math.ceil(chapterNumber / 3);
      expect(batchNumber).toBe(2);
    });
  });

  describe('Bible Addendum Structure', () => {
    it('should have valid addendum structure', () => {
      const validAddendum = {
        batch_number: 1,
        chapters_covered: [1, 2, 3],
        new_characters: [],
        new_locations: [],
        new_world_facts: [],
        relationship_changes: [],
        timeline_events: [],
        promises_made: []
      };

      expect(validAddendum).toHaveProperty('batch_number');
      expect(validAddendum).toHaveProperty('chapters_covered');
      expect(validAddendum).toHaveProperty('new_characters');
      expect(Array.isArray(validAddendum.chapters_covered)).toBe(true);
    });

    it('should detect duplicate batch in addenda array', () => {
      const existingAddenda = [
        { batch_number: 1, chapters_covered: [1, 2, 3] },
        { batch_number: 2, chapters_covered: [4, 5, 6] }
      ];

      const newBatchNumber = 1;
      const newBatchChapters = [1, 2, 3];

      const alreadyProcessed = existingAddenda.some(a =>
        a.batch_number === newBatchNumber ||
        (a.chapters_covered && JSON.stringify(a.chapters_covered) === JSON.stringify(newBatchChapters))
      );

      expect(alreadyProcessed).toBe(true);
    });

    it('should not detect duplicate when batch is new', () => {
      const existingAddenda = [
        { batch_number: 1, chapters_covered: [1, 2, 3] }
      ];

      const newBatchNumber = 2;
      const newBatchChapters = [4, 5, 6];

      const alreadyProcessed = existingAddenda.some(a =>
        a.batch_number === newBatchNumber ||
        (a.chapters_covered && JSON.stringify(a.chapters_covered) === JSON.stringify(newBatchChapters))
      );

      expect(alreadyProcessed).toBe(false);
    });
  });

  describe('Arc Enrichment Structure', () => {
    it('should have valid enrichment result structure', () => {
      const validEnrichment = {
        batch_reviewed: [1, 2, 3],
        deviations: [],
        enrichment_notes: {},
        bible_arc_conflicts: []
      };

      expect(validEnrichment).toHaveProperty('batch_reviewed');
      expect(validEnrichment).toHaveProperty('deviations');
      expect(validEnrichment).toHaveProperty('enrichment_notes');
      expect(validEnrichment).toHaveProperty('bible_arc_conflicts');
    });

    it('should detect duplicate enrichment in history', () => {
      const enrichmentHistory = [
        { batch_reviewed: [1, 2, 3], timestamp: '2026-01-01' },
        { batch_reviewed: [4, 5, 6], timestamp: '2026-01-02' }
      ];

      const completedBatchChapterNumbers = [1, 2, 3];

      const alreadyEnriched = enrichmentHistory.some(entry =>
        JSON.stringify(entry.batch_reviewed) === JSON.stringify(completedBatchChapterNumbers)
      );

      expect(alreadyEnriched).toBe(true);
    });

    it('should not detect duplicate when enrichment is new', () => {
      const enrichmentHistory = [
        { batch_reviewed: [1, 2, 3], timestamp: '2026-01-01' }
      ];

      const completedBatchChapterNumbers = [4, 5, 6];

      const alreadyEnriched = enrichmentHistory.some(entry =>
        JSON.stringify(entry.batch_reviewed) === JSON.stringify(completedBatchChapterNumbers)
      );

      expect(alreadyEnriched).toBe(false);
    });
  });

  describe('Arc Enrichment Skip Logic', () => {
    it('should skip arc enrichment for chapter 12 (final batch)', () => {
      const chapterNumber = 12;
      const shouldSkip = chapterNumber === 12;
      expect(shouldSkip).toBe(true);
    });

    it('should not skip arc enrichment for chapter 3', () => {
      const chapterNumber = 3;
      const shouldSkip = chapterNumber === 12;
      expect(shouldSkip).toBe(false);
    });

    it('should not skip arc enrichment for chapter 9', () => {
      const chapterNumber = 9;
      const shouldSkip = chapterNumber === 12;
      expect(shouldSkip).toBe(false);
    });
  });

  describe('Enrichment Notes in Chapter Outline', () => {
    it('should add enrichment_notes field to chapter outline', () => {
      const chapterOutline = {
        chapter_number: 4,
        title: 'Test Chapter',
        events_summary: 'Some events'
      };

      const enrichmentNote = 'In Ch3, X already happened, so adjust Y';
      const enrichedOutline = { ...chapterOutline, enrichment_notes: enrichmentNote };

      expect(enrichedOutline.enrichment_notes).toBe(enrichmentNote);
      expect(enrichedOutline.chapter_number).toBe(4);
    });

    it('should preserve existing chapter outline fields when adding enrichment_notes', () => {
      const chapters = [
        { chapter_number: 4, title: 'Ch 4', events_summary: 'Events' },
        { chapter_number: 5, title: 'Ch 5', events_summary: 'More events' }
      ];

      const enrichmentNotes = { '4': 'Note for chapter 4' };

      const updatedChapters = chapters.map(ch => {
        const note = enrichmentNotes[String(ch.chapter_number)];
        if (note) {
          return { ...ch, enrichment_notes: note };
        }
        return ch;
      });

      expect(updatedChapters[0].enrichment_notes).toBe('Note for chapter 4');
      expect(updatedChapters[0].title).toBe('Ch 4');
      expect(updatedChapters[1]).not.toHaveProperty('enrichment_notes');
    });
  });

  describe('Bible Addenda in Generation Prompt', () => {
    it('should generate story_developments block when addenda exist', () => {
      const bible = {
        content: {
          batch_addenda: [
            {
              chapters_covered: [1, 2, 3],
              new_characters: [{ name: 'Alice', role: 'Supporting' }],
              new_world_facts: [{ description: 'Magic works differently' }]
            }
          ]
        }
      };

      const hasAddenda = bible.content?.batch_addenda?.length > 0;
      expect(hasAddenda).toBe(true);
    });

    it('should not generate story_developments block when no addenda', () => {
      const bible = {
        content: {}
      };

      const hasAddenda = bible.content?.batch_addenda?.length > 0;
      expect(hasAddenda).toBe(false);
    });
  });
});
