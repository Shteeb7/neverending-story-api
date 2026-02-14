const { anthropic } = require('../config/ai-clients');
const { supabaseAdmin } = require('../config/supabase');

/**
 * Generate a writing intelligence snapshot from all dimension feedback data
 * Aggregates patterns by genre, age_range, and checkpoint
 * Returns snapshot IDs and summary counts
 */
async function generateWritingIntelligenceSnapshot() {
  console.log('📊 Generating writing intelligence snapshot...');

  // Query ALL story_feedback rows with dimension data
  // Join with stories to get genre
  // Join with story_premises to get preferences_used->ageRange
  const { data: feedbackRows, error: feedbackError } = await supabaseAdmin
    .from('story_feedback')
    .select(`
      *,
      story:stories!inner(genre, premise_id, premise:story_premises(preferences_used))
    `)
    .not('pacing_feedback', 'is', null);

  if (feedbackError) {
    throw new Error(`Failed to fetch feedback data: ${feedbackError.message}`);
  }

  if (!feedbackRows || feedbackRows.length === 0) {
    console.log('⚠️ No dimension feedback data available yet');
    return {
      success: true,
      snapshotIds: [],
      message: 'No feedback data available for analysis'
    };
  }

  console.log(`✅ Found ${feedbackRows.length} dimension feedback rows`);

  // Transform data to extract genre and age_range
  const enrichedFeedback = feedbackRows.map(row => {
    const genre = row.story?.genre || null;
    const ageRange = row.story?.premise?.preferences_used?.ageRange || null;

    return {
      ...row,
      genre,
      age_range: ageRange
    };
  });

  // Group by genre, age_range, and checkpoint
  const groups = {};
  enrichedFeedback.forEach(row => {
    const key = `${row.genre || 'unknown'}|${row.age_range || 'unknown'}|${row.checkpoint}`;
    if (!groups[key]) {
      groups[key] = {
        genre: row.genre,
        age_range: row.age_range,
        checkpoint: row.checkpoint,
        rows: []
      };
    }
    groups[key].rows.push(row);
  });

  console.log(`📊 Created ${Object.keys(groups).length} genre/age/checkpoint groups`);

  // Calculate distributions and metrics for each group
  const snapshotIds = [];
  const snapshotDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  for (const [key, group] of Object.entries(groups)) {
    const totalResponses = group.rows.length;

    // Calculate pacing distribution
    const pacingCounts = {};
    group.rows.forEach(r => {
      if (r.pacing_feedback) {
        pacingCounts[r.pacing_feedback] = (pacingCounts[r.pacing_feedback] || 0) + 1;
      }
    });

    // Calculate tone distribution
    const toneCounts = {};
    group.rows.forEach(r => {
      if (r.tone_feedback) {
        toneCounts[r.tone_feedback] = (toneCounts[r.tone_feedback] || 0) + 1;
      }
    });

    // Calculate character distribution
    const characterCounts = {};
    group.rows.forEach(r => {
      if (r.character_feedback) {
        characterCounts[r.character_feedback] = (characterCounts[r.character_feedback] || 0) + 1;
      }
    });

    // Calculate correction success rate
    // Logic: When reader said "slow" at checkpoint N, did they say "hooked" at checkpoint N+1?
    // For chapter_2 → chapter_5, chapter_5 → chapter_8
    let successfulCorrections = 0;
    let totalCorrections = 0;

    // Map checkpoint names to next checkpoint
    const checkpointSequence = {
      'chapter_2': 'chapter_5',
      'chapter_5': 'chapter_8'
    };

    group.rows.forEach(row => {
      const nextCheckpoint = checkpointSequence[row.checkpoint];
      if (!nextCheckpoint) return;

      // Find if there's a next checkpoint for the same story
      const nextFeedback = enrichedFeedback.find(
        r => r.story_id === row.story_id && r.checkpoint === nextCheckpoint
      );

      if (nextFeedback) {
        // Check if pacing correction worked
        if (row.pacing_feedback === 'slow' && nextFeedback.pacing_feedback === 'hooked') {
          successfulCorrections++;
        }
        if (row.pacing_feedback === 'fast' && nextFeedback.pacing_feedback === 'hooked') {
          successfulCorrections++;
        }

        // Check if tone correction worked
        if (row.tone_feedback === 'serious' && nextFeedback.tone_feedback === 'right') {
          successfulCorrections++;
        }
        if (row.tone_feedback === 'light' && nextFeedback.tone_feedback === 'right') {
          successfulCorrections++;
        }

        // Check if character correction worked
        if (row.character_feedback === 'not_clicking' && nextFeedback.character_feedback === 'love') {
          successfulCorrections++;
        }
        if (row.character_feedback === 'warming' && nextFeedback.character_feedback === 'love') {
          successfulCorrections++;
        }

        // Count total possible corrections
        if (['slow', 'fast'].includes(row.pacing_feedback)) totalCorrections++;
        if (['serious', 'light'].includes(row.tone_feedback)) totalCorrections++;
        if (['not_clicking', 'warming'].includes(row.character_feedback)) totalCorrections++;
      }
    });

    const correctionSuccessRate = totalCorrections > 0
      ? Math.round((successfulCorrections / totalCorrections) * 100 * 100) / 100
      : null;

    // Calculate abandonment rate
    // Stories where checkpoint exists but no subsequent checkpoint AND story status is not 'completed'
    const storyIds = [...new Set(group.rows.map(r => r.story_id))];
    let abandonedStories = 0;
    let abandonmentRate = null;

    // Only calculate abandonment if there's a next checkpoint in the sequence
    // (chapter_8 has no next checkpoint, so skip abandonment calculation)
    if (checkpointSequence[group.checkpoint]) {
      // Batch query for story statuses (avoid N+1 queries)
      const { data: storyStatuses } = await supabaseAdmin
        .from('stories')
        .select('id, status')
        .in('id', storyIds);

      // Create a lookup map for quick status checks
      const statusMap = {};
      if (storyStatuses) {
        storyStatuses.forEach(s => {
          statusMap[s.id] = s.status;
        });
      }

      for (const storyId of storyIds) {
        const storyFeedbacks = enrichedFeedback.filter(r => r.story_id === storyId);
        const hasNextCheckpoint = storyFeedbacks.some(r => r.checkpoint === checkpointSequence[group.checkpoint]);

        if (!hasNextCheckpoint) {
          // Check story status from batched results
          const status = statusMap[storyId];
          if (status && status !== 'completed') {
            abandonedStories++;
          }
        }
      }

      abandonmentRate = storyIds.length > 0
        ? Math.round((abandonedStories / storyIds.length) * 100 * 100) / 100
        : null;
    }

    // Generate insights using Claude
    const insightsPrompt = `You are analyzing aggregate reader feedback data for AI-generated stories.

<feedback_data>
Genre: ${group.genre || 'unknown'}
Age Range: ${group.age_range || 'unknown'}
Checkpoint: ${group.checkpoint}
Total Responses: ${totalResponses}

Pacing Distribution:
${Object.entries(pacingCounts).map(([k, v]) => `  ${k}: ${v} (${Math.round(v/totalResponses*100)}%)`).join('\n')}

Tone Distribution:
${Object.entries(toneCounts).map(([k, v]) => `  ${k}: ${v} (${Math.round(v/totalResponses*100)}%)`).join('\n')}

Character Distribution:
${Object.entries(characterCounts).map(([k, v]) => `  ${k}: ${v} (${Math.round(v/totalResponses*100)}%)`).join('\n')}

Correction Success Rate: ${correctionSuccessRate !== null ? correctionSuccessRate + '%' : 'N/A'}
Abandonment Rate: ${abandonmentRate !== null ? abandonmentRate + '%' : 'N/A'}
</feedback_data>

Generate 3-5 actionable observations about what this data reveals. Focus on:
- What's working well (patterns that suggest good defaults)
- What needs adjustment (patterns that suggest systemic issues)
- Genre/age-specific insights
- Statistically significant patterns (avoid over-interpreting small samples)

Return a JSON array of insight strings. Be specific and actionable.

Example format:
["High 'too serious' rate (55%) suggests fantasy base prompts need more humor", "Strong correction success rate (78%) indicates course correction system is working", "Low abandonment (8%) at chapter_2 indicates strong initial engagement"]`;

    try {
      const insightsResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: insightsPrompt
        }]
      });

      const insightsText = insightsResponse.content[0].text;
      let insights = [];

      try {
        // Try to parse as JSON
        insights = JSON.parse(insightsText);
      } catch (e) {
        // If not valid JSON, wrap as single insight
        insights = [insightsText];
      }

      // Insert snapshot into database
      const { data: snapshot, error: insertError } = await supabaseAdmin
        .from('writing_intelligence_snapshots')
        .insert({
          snapshot_date: snapshotDate,
          genre: group.genre,
          age_range: group.age_range,
          checkpoint: group.checkpoint,
          total_responses: totalResponses,
          pacing_distribution: pacingCounts,
          tone_distribution: toneCounts,
          character_distribution: characterCounts,
          correction_success_rate: correctionSuccessRate,
          abandonment_rate: abandonmentRate,
          insights: insights,
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (insertError) {
        console.error(`❌ Failed to insert snapshot for ${key}:`, insertError.message);
      } else {
        console.log(`✅ Created snapshot for ${key}: ${snapshot.id}`);
        snapshotIds.push(snapshot.id);
      }
    } catch (error) {
      console.error(`❌ Failed to generate insights for ${key}:`, error.message);
    }
  }

  console.log(`✅ Generated ${snapshotIds.length} snapshots`);

  return {
    success: true,
    snapshotIds,
    totalSnapshots: snapshotIds.length,
    totalFeedbackRows: feedbackRows.length,
    message: 'Writing intelligence snapshot generated successfully'
  };
}

/**
 * Generate a comprehensive writing intelligence report
 * Analyzes latest snapshots and produces actionable recommendations
 * Returns structured report with top issues, genre findings, and prompt adjustments
 */
async function generateWritingIntelligenceReport() {
  console.log('📊 Generating writing intelligence report...');

  // Pull latest snapshots (most recent snapshot_date for each genre/age/checkpoint combo)
  const { data: snapshots, error: snapshotsError } = await supabaseAdmin
    .from('writing_intelligence_snapshots')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);

  if (snapshotsError) {
    throw new Error(`Failed to fetch snapshots: ${snapshotsError.message}`);
  }

  if (!snapshots || snapshots.length === 0) {
    return {
      success: true,
      report: {
        message: 'No snapshot data available yet. Generate a snapshot first.'
      }
    };
  }

  console.log(`✅ Found ${snapshots.length} snapshots`);

  // Build comprehensive prompt for Claude
  const reportPrompt = `You are analyzing aggregate reader feedback data for an AI story generation system. Your goal is to identify systemic patterns and recommend specific prompt adjustments.

<snapshot_data>
${snapshots.map(s => `
Genre: ${s.genre || 'unknown'}
Age Range: ${s.age_range || 'unknown'}
Checkpoint: ${s.checkpoint}
Total Responses: ${s.total_responses}
Pacing: ${JSON.stringify(s.pacing_distribution)}
Tone: ${JSON.stringify(s.tone_distribution)}
Character: ${JSON.stringify(s.character_distribution)}
Correction Success: ${s.correction_success_rate !== null ? s.correction_success_rate + '%' : 'N/A'}
Abandonment: ${s.abandonment_rate !== null ? s.abandonment_rate + '%' : 'N/A'}
Insights: ${JSON.stringify(s.insights)}
---
`).join('\n')}
</snapshot_data>

Analyze this data and produce a structured report. Return ONLY valid JSON with this exact structure:

{
  "systemic_issues": [
    {
      "issue": "Brief description of the systemic pattern",
      "evidence": "What data supports this (e.g., '70% of fantasy readers report too serious')",
      "impact": "Why this matters (e.g., 'High abandonment correlation')",
      "recommendation": "Specific actionable change"
    }
  ],
  "genre_specific_findings": {
    "fantasy": [
      {
        "finding": "Description of genre-specific pattern",
        "recommendation": "Specific adjustment for this genre"
      }
    ]
  },
  "recommended_prompt_adjustments": [
    {
      "adjustment_type": "base_prompt OR genre_default OR quality_rubric",
      "genre": "genre name or null for all genres",
      "description": "Clear description of what to change",
      "confidence": 0.0-1.0,
      "sample_size": number,
      "rationale": "Why this change is recommended"
    }
  ],
  "summary": "2-3 sentence executive summary of key findings"
}

IMPORTANT:
- Only recommend changes supported by statistically significant patterns (sample size > 20 preferred)
- Be specific about what to change (not just "add more humor" but "increase humor_level parameter from 0.3 to 0.5")
- Flag low-confidence recommendations based on small sample sizes
- Focus on actionable changes to generation prompts, not vague observations`;

  try {
    const reportResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: reportPrompt
      }]
    });

    const reportText = reportResponse.content[0].text;

    // Parse JSON from response
    let report;
    try {
      // Remove markdown code blocks if present
      const cleanedText = reportText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      report = JSON.parse(cleanedText);
    } catch (e) {
      console.error('❌ Failed to parse report JSON:', e.message);
      return {
        success: false,
        error: 'Failed to parse report from Claude',
        rawResponse: reportText
      };
    }

    console.log('✅ Writing intelligence report generated');

    return {
      success: true,
      report,
      metadata: {
        snapshots_analyzed: snapshots.length,
        generated_at: new Date().toISOString()
      }
    };
  } catch (error) {
    console.error('❌ Failed to generate report:', error.message);
    throw error;
  }
}

/**
 * Log a manual prompt adjustment to the database
 * Records when a human makes a change to base prompts based on aggregate data
 * Returns the logged row
 */
async function logPromptAdjustment(
  adjustmentType,
  genre,
  description,
  previousValue,
  newValue,
  dataBasis,
  snapshotId,
  appliedBy = 'manual'
) {
  console.log('📝 Logging prompt adjustment...');

  const { data: adjustment, error: insertError } = await supabaseAdmin
    .from('prompt_adjustment_log')
    .insert({
      adjustment_type: adjustmentType,
      genre: genre || null,
      description,
      previous_value: previousValue,
      new_value: newValue,
      data_basis: dataBasis,
      snapshot_id: snapshotId || null,
      applied_by: appliedBy,
      created_at: new Date().toISOString()
    })
    .select()
    .single();

  if (insertError) {
    throw new Error(`Failed to log adjustment: ${insertError.message}`);
  }

  console.log(`✅ Logged adjustment: ${adjustment.id}`);

  return {
    success: true,
    adjustment
  };
}

module.exports = {
  generateWritingIntelligenceSnapshot,
  generateWritingIntelligenceReport,
  logPromptAdjustment
};
