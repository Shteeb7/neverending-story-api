const supabase = require('../config/supabase');

/**
 * Compute a quality snapshot for a single story by aggregating data from multiple tables.
 * Inserts a row into quality_snapshots and returns the computed metrics.
 */
async function computeStoryQualitySnapshot(storyId) {
  const today = new Date().toISOString().split('T')[0];

  // Fetch story metadata
  const { data: story, error: storyError } = await supabase
    .from('stories')
    .select('id, title, generation_config')
    .eq('id', storyId)
    .maybeSingle();

  if (storyError || !story) {
    throw new Error(`Story not found: ${storyId}`);
  }

  const storyTitle = story.title || 'Untitled';
  console.log(`📊 Computing quality snapshot for story: ${storyTitle}`);

  // Fetch all chapters for this story
  const { data: chapters, error: chaptersError } = await supabase
    .from('chapters')
    .select('chapter_number, quality_score, quality_review, regeneration_count')
    .eq('story_id', storyId)
    .order('chapter_number');

  if (chaptersError) {
    throw new Error(`Failed to fetch chapters: ${chaptersError.message}`);
  }

  if (!chapters || chapters.length === 0) {
    console.log(`📊 [${storyTitle}] No chapters found, skipping snapshot`);
    return null;
  }

  // AI quality signals from chapters
  let qualityScores = [];
  let dimensionScores = {
    show_dont_tell: [],
    dialogue_quality: [],
    pacing_engagement: [],
    age_appropriateness: [],
    character_consistency: [],
    prose_quality: []
  };
  let regenerationCounts = [];

  for (const chapter of chapters) {
    if (chapter.quality_score != null) {
      qualityScores.push(parseFloat(chapter.quality_score));
    }
    if (chapter.regeneration_count != null) {
      regenerationCounts.push(parseInt(chapter.regeneration_count));
    }

    // Extract dimension scores from quality_review JSONB
    if (chapter.quality_review?.criteria_scores) {
      const scores = chapter.quality_review.criteria_scores;
      for (const dim in dimensionScores) {
        if (scores[dim] != null) {
          dimensionScores[dim].push(parseFloat(scores[dim]));
        }
      }
    }
  }

  const ai_quality_avg = qualityScores.length > 0
    ? (qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length)
    : null;

  const avg_regeneration_count = regenerationCounts.length > 0
    ? (regenerationCounts.reduce((a, b) => a + b, 0) / regenerationCounts.length)
    : null;

  const dimensionAverages = {};
  for (const dim in dimensionScores) {
    if (dimensionScores[dim].length > 0) {
      dimensionAverages[dim] = dimensionScores[dim].reduce((a, b) => a + b, 0) / dimensionScores[dim].length;
    } else {
      dimensionAverages[dim] = null;
    }
  }

  // Voice authenticity from character_voice_reviews
  const { data: voiceReviews, error: voiceError } = await supabase
    .from('character_voice_reviews')
    .select('review_data, revision_applied')
    .eq('story_id', storyId);

  let voiceScores = [];
  let revisionCount = 0;
  let totalReviews = 0;

  if (!voiceError && voiceReviews) {
    totalReviews = voiceReviews.length;
    for (const review of voiceReviews) {
      if (review.revision_applied) revisionCount++;

      if (review.review_data?.voice_checks) {
        for (const check of review.review_data.voice_checks) {
          if (check.authenticity_score != null) {
            voiceScores.push(parseFloat(check.authenticity_score));
          }
        }
      }
    }
  }

  const voice_authenticity_avg = voiceScores.length > 0
    ? (voiceScores.reduce((a, b) => a + b, 0) / voiceScores.length)
    : null;

  const revision_rate = totalReviews > 0 ? (revisionCount / totalReviews) : null;

  // Callback utilization from character_ledger_entries
  const { data: ledgerEntries, error: ledgerError } = await supabase
    .from('character_ledger_entries')
    .select('callback_bank')
    .eq('story_id', storyId);

  let totalCallbacks = 0;
  let usedCallbacks = 0;

  if (!ledgerError && ledgerEntries) {
    for (const entry of ledgerEntries) {
      if (entry.callback_bank && Array.isArray(entry.callback_bank)) {
        totalCallbacks += entry.callback_bank.length;
        usedCallbacks += entry.callback_bank.filter(cb => cb.status === 'used').length;
      }
    }
  }

  const callback_utilization = totalCallbacks > 0 ? (usedCallbacks / totalCallbacks) : null;

  // Reader signals from story_feedback
  const { data: feedback, error: feedbackError } = await supabase
    .from('story_feedback')
    .select('pacing_feedback, tone_feedback, character_feedback, follow_up_action')
    .eq('story_id', storyId);

  let pacingDist = {};
  let toneDist = {};
  let characterDist = {};
  let followUpCount = 0;

  if (!feedbackError && feedback) {
    for (const fb of feedback) {
      if (fb.pacing_feedback) {
        pacingDist[fb.pacing_feedback] = (pacingDist[fb.pacing_feedback] || 0) + 1;
      }
      if (fb.tone_feedback) {
        toneDist[fb.tone_feedback] = (toneDist[fb.tone_feedback] || 0) + 1;
      }
      if (fb.character_feedback) {
        characterDist[fb.character_feedback] = (characterDist[fb.character_feedback] || 0) + 1;
      }
      if (fb.follow_up_action) {
        followUpCount++;
      }
    }
  }

  const reader_pacing_satisfaction = Object.keys(pacingDist).length > 0 ? JSON.stringify(pacingDist) : null;
  const reader_tone_satisfaction = Object.keys(toneDist).length > 0 ? JSON.stringify(toneDist) : null;
  const reader_character_satisfaction = Object.keys(characterDist).length > 0 ? JSON.stringify(characterDist) : null;

  // Completion rate from chapter_reading_stats
  const { data: readingStats, error: statsError } = await supabase
    .from('chapter_reading_stats')
    .select('completed, total_reading_time_seconds')
    .eq('story_id', storyId);

  let completedCount = 0;
  let totalStats = 0;
  let totalReadingTime = [];

  if (!statsError && readingStats) {
    totalStats = readingStats.length;
    for (const stat of readingStats) {
      if (stat.completed) completedCount++;
      if (stat.total_reading_time_seconds != null) {
        totalReadingTime.push(parseInt(stat.total_reading_time_seconds));
      }
    }
  }

  const completion_rate = totalStats > 0 ? (completedCount / totalStats) : null;
  const avg_reading_time_per_chapter = totalReadingTime.length > 0
    ? Math.round(totalReadingTime.reduce((a, b) => a + b, 0) / totalReadingTime.length)
    : null;

  // Abandonment chapter from reading_sessions
  const { data: sessions, error: sessionsError } = await supabase
    .from('reading_sessions')
    .select('chapter_number, abandoned')
    .eq('story_id', storyId)
    .eq('abandoned', true)
    .order('chapter_number', { ascending: true })
    .limit(1);

  const abandonment_chapter = (!sessionsError && sessions && sessions.length > 0)
    ? sessions[0].chapter_number
    : null;

  // Cost data from api_costs
  const { data: costs, error: costsError } = await supabase
    .from('api_costs')
    .select('cost, operation')
    .eq('story_id', storyId);

  let total_generation_cost = 0;
  let costByOperation = {};

  if (!costsError && costs) {
    for (const cost of costs) {
      const amount = parseFloat(cost.cost) || 0;
      total_generation_cost += amount;
      if (cost.operation) {
        costByOperation[cost.operation] = (costByOperation[cost.operation] || 0) + amount;
      }
    }
  }

  const cost_per_chapter = chapters.length > 0 ? (total_generation_cost / chapters.length) : null;

  // Build the snapshot object
  const snapshot = {
    snapshot_date: today,
    story_id: storyId,
    ai_quality_avg,
    voice_authenticity_avg,
    revision_rate,
    callback_utilization,
    reader_pacing_satisfaction,
    reader_tone_satisfaction,
    reader_character_satisfaction,
    completion_rate,
    avg_reading_time_per_chapter,
    abandonment_chapter,
    generation_config: story.generation_config,
    total_generation_cost,
    cost_per_chapter
  };

  // Insert into quality_snapshots
  const { error: insertError } = await supabase
    .from('quality_snapshots')
    .insert(snapshot);

  if (insertError) {
    console.error(`❌ [${storyTitle}] Failed to insert quality snapshot: ${insertError.message}`);
  } else {
    console.log(`📊 [${storyTitle}] Quality snapshot computed: quality=${ai_quality_avg?.toFixed(1) || 'N/A'}, voice=${voice_authenticity_avg?.toFixed(2) || 'N/A'}, completion=${completion_rate != null ? Math.round(completion_rate * 100) + '%' : 'N/A'}`);
  }

  // Return full data including dimension breakdowns and cost breakdown
  return {
    ...snapshot,
    dimension_scores: dimensionAverages,
    avg_regeneration_count,
    follow_up_feedback_count: followUpCount,
    cost_by_operation: costByOperation,
    chapter_count: chapters.length
  };
}

/**
 * Compute fleet-level quality dashboard by aggregating across multiple stories.
 */
async function computeDashboard(options = {}) {
  const { storyIds, since, limit = 20 } = options;

  console.log(`📊 Computing fleet dashboard: limit=${limit}, since=${since || 'all time'}`);

  // Build query for qualifying stories
  let query = supabase
    .from('stories')
    .select('id, title, created_at, generation_config')
    .neq('status', 'error')
    .order('created_at', { ascending: false });

  if (storyIds && storyIds.length > 0) {
    query = query.in('id', storyIds);
  }

  if (since) {
    query = query.gte('created_at', since);
  }

  query = query.limit(limit);

  const { data: stories, error: storiesError } = await query;

  if (storiesError) {
    throw new Error(`Failed to fetch stories: ${storiesError.message}`);
  }

  if (!stories || stories.length === 0) {
    console.log('📊 No qualifying stories found');
    return {
      fleet_quality_avg: null,
      fleet_voice_avg: null,
      fleet_revision_rate: null,
      fleet_callback_utilization: null,
      fleet_completion_rate: null,
      fleet_cost_per_chapter: null,
      total_stories_analyzed: 0,
      total_chapters_analyzed: 0,
      dimension_averages: {},
      weakest_dimension: null,
      cost_by_system: {},
      feature_flag_distribution: {}
    };
  }

  // For each story, check if it has at least 1 chapter
  const storiesWithChapters = [];
  for (const story of stories) {
    const { count } = await supabase
      .from('chapters')
      .select('id', { count: 'exact', head: true })
      .eq('story_id', story.id);

    if (count && count > 0) {
      storiesWithChapters.push(story);
    }
  }

  if (storiesWithChapters.length === 0) {
    console.log('📊 No stories with chapters found');
    return {
      fleet_quality_avg: null,
      fleet_voice_avg: null,
      fleet_revision_rate: null,
      fleet_callback_utilization: null,
      fleet_completion_rate: null,
      fleet_cost_per_chapter: null,
      total_stories_analyzed: 0,
      total_chapters_analyzed: 0,
      dimension_averages: {},
      weakest_dimension: null,
      cost_by_system: {},
      feature_flag_distribution: {}
    };
  }

  // Compute snapshot for each story
  const snapshots = [];
  for (const story of storiesWithChapters) {
    try {
      const snapshot = await computeStoryQualitySnapshot(story.id);
      if (snapshot) {
        snapshots.push(snapshot);
      }
    } catch (error) {
      console.error(`❌ Failed to compute snapshot for story ${story.id}: ${error.message}`);
    }
  }

  // Aggregate fleet-level metrics
  let qualityScores = [];
  let voiceScores = [];
  let revisionRates = [];
  let callbackRates = [];
  let completionRates = [];
  let costPerChapter = [];
  let totalChapters = 0;
  let dimensionAggregates = {};
  let costBySystem = {};
  let featureFlagCounts = {
    character_ledger: { enabled: 0, disabled: 0 },
    voice_review: { enabled: 0, disabled: 0 },
    adaptive_preferences: { enabled: 0, disabled: 0 },
    course_corrections: { enabled: 0, disabled: 0 }
  };

  for (const snapshot of snapshots) {
    if (snapshot.ai_quality_avg != null) qualityScores.push(snapshot.ai_quality_avg);
    if (snapshot.voice_authenticity_avg != null) voiceScores.push(snapshot.voice_authenticity_avg);
    if (snapshot.revision_rate != null) revisionRates.push(snapshot.revision_rate);
    if (snapshot.callback_utilization != null) callbackRates.push(snapshot.callback_utilization);
    if (snapshot.completion_rate != null) completionRates.push(snapshot.completion_rate);
    if (snapshot.cost_per_chapter != null) costPerChapter.push(snapshot.cost_per_chapter);
    if (snapshot.chapter_count) totalChapters += snapshot.chapter_count;

    // Aggregate dimensions
    if (snapshot.dimension_scores) {
      for (const dim in snapshot.dimension_scores) {
        if (snapshot.dimension_scores[dim] != null) {
          if (!dimensionAggregates[dim]) dimensionAggregates[dim] = [];
          dimensionAggregates[dim].push(snapshot.dimension_scores[dim]);
        }
      }
    }

    // Aggregate cost by operation
    if (snapshot.cost_by_operation) {
      for (const op in snapshot.cost_by_operation) {
        costBySystem[op] = (costBySystem[op] || 0) + snapshot.cost_by_operation[op];
      }
    }

    // Feature flag distribution
    const config = snapshot.generation_config || {};
    for (const flag in featureFlagCounts) {
      if (config[flag] === false) {
        featureFlagCounts[flag].disabled++;
      } else {
        featureFlagCounts[flag].enabled++;
      }
    }
  }

  const avg = (arr) => arr.length > 0 ? (arr.reduce((a, b) => a + b, 0) / arr.length) : null;

  const fleet_quality_avg = avg(qualityScores);
  const fleet_voice_avg = avg(voiceScores);
  const fleet_revision_rate = avg(revisionRates);
  const fleet_callback_utilization = avg(callbackRates);
  const fleet_completion_rate = avg(completionRates);
  const fleet_cost_per_chapter = avg(costPerChapter);

  // Compute dimension averages and find weakest
  const dimension_averages = {};
  let weakest_dimension = null;
  let weakest_score = 10;

  for (const dim in dimensionAggregates) {
    const dimAvg = avg(dimensionAggregates[dim]);
    dimension_averages[dim] = dimAvg;
    if (dimAvg != null && dimAvg < weakest_score) {
      weakest_score = dimAvg;
      weakest_dimension = dim;
    }
  }

  // Average cost per system per chapter
  const cost_by_system_avg = {};
  for (const op in costBySystem) {
    cost_by_system_avg[op] = totalChapters > 0 ? (costBySystem[op] / totalChapters) : costBySystem[op];
  }

  console.log(`📊 Fleet dashboard: ${snapshots.length} stories analyzed, avg quality=${fleet_quality_avg?.toFixed(1) || 'N/A'}, weakest dimension=${weakest_dimension || 'N/A'}`);

  return {
    fleet_quality_avg,
    fleet_voice_avg,
    fleet_revision_rate,
    fleet_callback_utilization,
    fleet_completion_rate,
    fleet_cost_per_chapter,
    total_stories_analyzed: snapshots.length,
    total_chapters_analyzed: totalChapters,
    dimension_averages,
    weakest_dimension,
    cost_by_system: cost_by_system_avg,
    feature_flag_distribution: featureFlagCounts,
    stories: snapshots.map(s => ({
      story_id: s.story_id,
      quality: s.ai_quality_avg,
      voice: s.voice_authenticity_avg,
      revision_rate: s.revision_rate,
      callback_utilization: s.callback_utilization,
      completion_rate: s.completion_rate,
      cost_per_chapter: s.cost_per_chapter,
      chapter_count: s.chapter_count
    }))
  };
}

/**
 * Get detailed quality breakdown for a single story.
 */
async function getStoryQualityDetail(storyId) {
  console.log(`📊 Fetching quality detail for story: ${storyId}`);

  // Compute full snapshot
  const snapshot = await computeStoryQualitySnapshot(storyId);

  if (!snapshot) {
    return { error: 'No data available for this story' };
  }

  // Fetch per-chapter data
  const { data: chapters, error: chaptersError } = await supabase
    .from('chapters')
    .select('chapter_number, quality_score')
    .eq('story_id', storyId)
    .order('chapter_number');

  if (chaptersError) {
    throw new Error(`Failed to fetch chapters: ${chaptersError.message}`);
  }

  // Fetch voice reviews per chapter
  const { data: voiceReviews, error: voiceError } = await supabase
    .from('character_voice_reviews')
    .select('chapter_number, review_data, revision_applied')
    .eq('story_id', storyId);

  const voiceByChapter = {};
  if (!voiceError && voiceReviews) {
    for (const review of voiceReviews) {
      const chNum = review.chapter_number;
      if (!voiceByChapter[chNum]) {
        voiceByChapter[chNum] = { scores: [], had_revision: false };
      }
      if (review.revision_applied) {
        voiceByChapter[chNum].had_revision = true;
      }
      if (review.review_data?.voice_checks) {
        for (const check of review.review_data.voice_checks) {
          if (check.authenticity_score != null) {
            voiceByChapter[chNum].scores.push(parseFloat(check.authenticity_score));
          }
        }
      }
    }
  }

  // Fetch ledger entries per chapter
  const { data: ledgerEntries, error: ledgerError } = await supabase
    .from('character_ledger_entries')
    .select('chapter_number')
    .eq('story_id', storyId);

  const ledgerByChapter = new Set();
  if (!ledgerError && ledgerEntries) {
    for (const entry of ledgerEntries) {
      ledgerByChapter.add(entry.chapter_number);
    }
  }

  // Build per-chapter breakdown
  const per_chapter_quality = chapters.map(ch => {
    const voiceData = voiceByChapter[ch.chapter_number];
    const voiceAvg = voiceData && voiceData.scores.length > 0
      ? (voiceData.scores.reduce((a, b) => a + b, 0) / voiceData.scores.length)
      : null;

    return {
      chapter_number: ch.chapter_number,
      quality_score: ch.quality_score,
      voice_authenticity: voiceAvg,
      had_revision: voiceData ? voiceData.had_revision : false,
      has_ledger_entry: ledgerByChapter.has(ch.chapter_number)
    };
  });

  // Quality trend: first half vs second half
  const midpoint = Math.floor(chapters.length / 2);
  const firstHalf = chapters.slice(0, midpoint).filter(ch => ch.quality_score != null);
  const secondHalf = chapters.slice(midpoint).filter(ch => ch.quality_score != null);

  const firstHalfAvg = firstHalf.length > 0
    ? (firstHalf.reduce((sum, ch) => sum + parseFloat(ch.quality_score), 0) / firstHalf.length)
    : null;
  const secondHalfAvg = secondHalf.length > 0
    ? (secondHalf.reduce((sum, ch) => sum + parseFloat(ch.quality_score), 0) / secondHalf.length)
    : null;

  let quality_trend = 'stable';
  if (firstHalfAvg != null && secondHalfAvg != null) {
    const diff = secondHalfAvg - firstHalfAvg;
    if (diff > 0.3) quality_trend = 'improving';
    else if (diff < -0.3) quality_trend = 'declining';
  }

  return {
    snapshot,
    per_chapter_quality,
    quality_trend,
    quality_trend_details: {
      first_half_avg: firstHalfAvg,
      second_half_avg: secondHalfAvg
    }
  };
}

module.exports = {
  computeStoryQualitySnapshot,
  computeDashboard,
  getStoryQualityDetail
};
