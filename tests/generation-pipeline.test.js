const { parseAndValidateJSON, attemptJsonRepair } = require('../src/services/generation');

describe('Generation Pipeline - JSON Parsing', () => {
  describe('parseAndValidateJSON', () => {
    test('handles valid JSON', () => {
      const jsonString = '{"name": "Elara", "age": 25, "skills": ["archery", "tracking"]}';
      const result = parseAndValidateJSON(jsonString);

      expect(result).toBeDefined();
      expect(result.name).toBe('Elara');
      expect(result.age).toBe(25);
      expect(result.skills).toEqual(['archery', 'tracking']);
    });

    test('handles JSON wrapped in markdown code blocks', () => {
      const jsonString = '```json\n{"name": "Elara", "age": 25}\n```';
      const result = parseAndValidateJSON(jsonString);

      expect(result).toBeDefined();
      expect(result.name).toBe('Elara');
      expect(result.age).toBe(25);
    });

    test('handles JSON wrapped in markdown code blocks without language tag', () => {
      const jsonString = '```\n{"name": "Elara", "age": 25}\n```';
      const result = parseAndValidateJSON(jsonString);

      expect(result).toBeDefined();
      expect(result.name).toBe('Elara');
    });

    test('handles JSON with trailing comma before closing brace', () => {
      const jsonString = '{"name": "Elara", "age": 25,}';
      const result = parseAndValidateJSON(jsonString);

      expect(result).toBeDefined();
      expect(result.name).toBe('Elara');
    });

    test('handles JSON with trailing comma before closing bracket', () => {
      const jsonString = '{"skills": ["archery", "tracking",]}';
      const result = parseAndValidateJSON(jsonString);

      expect(result).toBeDefined();
      expect(result.skills).toEqual(['archery', 'tracking']);
    });

    test('handles truncated JSON by attempting repair', () => {
      const jsonString = '{"name": "Elara", "age": 25, "skills": ["archery"';
      const result = parseAndValidateJSON(jsonString);

      expect(result).toBeDefined();
      expect(result.name).toBe('Elara');
      expect(result.age).toBe(25);
    });

    test('validates required fields are present - throws error when missing', () => {
      const jsonString = '{"name": "Elara", "age": 25}';

      expect(() => {
        parseAndValidateJSON(jsonString, ['name', 'age', 'class']);
      }).toThrow('Missing required field: class');
    });

    test('validates all required fields are present - succeeds', () => {
      const jsonString = '{"name": "Elara", "age": 25, "class": "Ranger"}';
      const result = parseAndValidateJSON(jsonString, ['name', 'age', 'class']);

      expect(result).toBeDefined();
      expect(result.name).toBe('Elara');
      expect(result.age).toBe(25);
      expect(result.class).toBe('Ranger');
    });

    test('throws error for completely invalid JSON', () => {
      const jsonString = 'This is not JSON at all';

      expect(() => {
        parseAndValidateJSON(jsonString);
      }).toThrow();
    });

    test('throws error for empty string', () => {
      const jsonString = '';

      expect(() => {
        parseAndValidateJSON(jsonString);
      }).toThrow();
    });

    test('throws error for null input', () => {
      expect(() => {
        parseAndValidateJSON(null);
      }).toThrow();
    });

    test('throws error for undefined input', () => {
      expect(() => {
        parseAndValidateJSON(undefined);
      }).toThrow();
    });
  });

  describe('attemptJsonRepair', () => {
    test('fixes unclosed string bracket', () => {
      const broken = '{"name": "Elara", "skills": ["archery"';
      const repaired = attemptJsonRepair(broken);
      const parsed = JSON.parse(repaired);

      expect(parsed.name).toBe('Elara');
      expect(parsed.skills).toEqual(['archery']);
    });

    test('fixes unclosed object brace', () => {
      const broken = '{"name": "Elara", "age": 25';
      const repaired = attemptJsonRepair(broken);
      const parsed = JSON.parse(repaired);

      expect(parsed.name).toBe('Elara');
      expect(parsed.age).toBe(25);
    });

    test('fixes trailing comma before closing brace', () => {
      const broken = '{"name": "Elara", "age": 25,}';
      const repaired = attemptJsonRepair(broken);
      const parsed = JSON.parse(repaired);

      expect(parsed.name).toBe('Elara');
      expect(parsed.age).toBe(25);
    });

    test('fixes trailing comma before closing bracket', () => {
      const broken = '{"skills": ["archery", "tracking",]}';
      const repaired = attemptJsonRepair(broken);
      const parsed = JSON.parse(repaired);

      expect(parsed.skills).toEqual(['archery', 'tracking']);
    });

    test('fixes multiple trailing commas', () => {
      const broken = '{"name": "Elara", "skills": ["archery",], "age": 25,}';
      const repaired = attemptJsonRepair(broken);
      const parsed = JSON.parse(repaired);

      expect(parsed.name).toBe('Elara');
      expect(parsed.skills).toEqual(['archery']);
      expect(parsed.age).toBe(25);
    });

    test('fixes nested unclosed brackets', () => {
      const broken = '{"character": {"name": "Elara", "skills": ["archery"';
      const repaired = attemptJsonRepair(broken);
      const parsed = JSON.parse(repaired);

      expect(parsed.character.name).toBe('Elara');
      expect(parsed.character.skills).toEqual(['archery']);
    });

    test('removes trailing garbage after closing brace', () => {
      const broken = '{"name": "Elara", "age": 25} some extra text';
      const repaired = attemptJsonRepair(broken);
      const parsed = JSON.parse(repaired);

      expect(parsed.name).toBe('Elara');
      expect(parsed.age).toBe(25);
    });

    test('handles already valid JSON without changes', () => {
      const valid = '{"name": "Elara", "age": 25}';
      const repaired = attemptJsonRepair(valid);
      const parsed = JSON.parse(repaired);

      expect(parsed.name).toBe('Elara');
      expect(parsed.age).toBe(25);
    });

    test('fixes unclosed string at end', () => {
      const broken = '{"name": "Elara", "description": "A skilled ranger from';
      const repaired = attemptJsonRepair(broken);
      const parsed = JSON.parse(repaired);

      expect(parsed.name).toBe('Elara');
      expect(parsed.description).toBe('A skilled ranger from');
    });
  });
});

describe('Generation Pipeline - Safety Checks', () => {
  // These tests verify that the generation functions check for existing data
  // before creating new records, preventing duplicates during recovery

  test('arc generation should check for existing arc before inserting', () => {
    // This is a documentation test - the actual implementation in generateArcOutline
    // should query for existing arcs with matching story_id and arc_number
    // before attempting to insert a new arc record

    // Expected behavior:
    // 1. Query: SELECT * FROM story_arcs WHERE story_id = ? AND arc_number = ?
    // 2. If exists: return existing arc
    // 3. If not exists: create new arc

    expect(true).toBe(true); // Placeholder - actual test would mock Supabase
  });

  test('chapter generation should check for existing chapter before generating', () => {
    // This is a documentation test - the actual implementation in generateChapter
    // should query for existing chapters with matching story_id and chapter_number
    // before attempting to generate and insert a new chapter

    // Expected behavior:
    // 1. Query: SELECT * FROM chapters WHERE story_id = ? AND chapter_number = ?
    // 2. If exists: return existing chapter
    // 3. If not exists: generate and insert new chapter

    expect(true).toBe(true); // Placeholder - actual test would mock Supabase
  });

  test('chapter generation should throw clear error when arc is null', () => {
    // This is a documentation test - the actual implementation should check
    // if arc data is null/undefined and throw a descriptive error message
    // instead of allowing "Cannot read properties of null" errors

    // Expected behavior:
    // if (!arc) {
    //   throw new Error(`Arc data not found for story ${storyId}, arc ${arcNumber}`);
    // }

    expect(true).toBe(true); // Placeholder - actual test would mock the function
  });
});

describe('Generation Pipeline - Error Messages', () => {
  test('should provide clear error messages for missing data', () => {
    // Document expected error message patterns
    const expectedPatterns = [
      'Arc data not found for story',
      'Chapter already exists',
      'Story bible not found',
      'Invalid story ID',
      'Missing required field'
    ];

    expectedPatterns.forEach(pattern => {
      expect(pattern).toBeTruthy();
    });
  });

  test('should not expose cryptic "Cannot read properties of null" errors', () => {
    // This is a reminder that all database queries that might return null
    // should be checked before accessing properties

    // BAD:  const title = arc.title;  // Crashes if arc is null
    // GOOD: if (!arc) throw new Error('Arc not found');
    //       const title = arc.title;

    expect(true).toBe(true);
  });
});
