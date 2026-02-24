/**
 * WHISPERNET PUBLICATIONS ROUTES
 *
 * Handles publication of stories to WhisperNet discovery portal and content classification.
 */

const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');

/**
 * POST /api/publications/:id/classify
 *
 * Content classification stub endpoint.
 * For now, accepts publisher self-classification.
 * Full classification pipeline (AI, reviewer, or hybrid) is owned by WhisperNet team.
 */
router.post('/:id/classify', async (req, res) => {
  try {
    const { id } = req.params;
    const { maturity_rating } = req.body;

    // Validate maturity_rating
    const validRatings = ['all_ages', 'teen_13', 'mature_17'];
    if (!maturity_rating || !validRatings.includes(maturity_rating)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid maturity_rating. Must be one of: all_ages, teen_13, mature_17'
      });
    }

    // Get authenticated user
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    // Verify publication exists and belongs to user
    const { data: publication, error: pubError } = await supabase
      .from('whispernet_publications')
      .select('publisher_id')
      .eq('id', id)
      .maybeSingle();

    if (pubError) {
      console.error('Error fetching publication:', pubError);
      return res.status(500).json({ success: false, error: 'Database error' });
    }

    if (!publication) {
      return res.status(404).json({ success: false, error: 'Publication not found' });
    }

    if (publication.publisher_id !== user.id) {
      return res.status(403).json({ success: false, error: 'Forbidden: not the publisher' });
    }

    // Update maturity rating (stub - full classification pipeline is WhisperNet team scope)
    const { error: updateError } = await supabase
      .from('whispernet_publications')
      .update({ maturity_rating })
      .eq('id', id);

    if (updateError) {
      console.error('Error updating maturity rating:', updateError);
      return res.status(500).json({ success: false, error: 'Failed to update classification' });
    }

    res.json({
      success: true,
      maturity_rating,
      message: 'Classification updated (self-classified by publisher)'
    });

  } catch (error) {
    console.error('Classification endpoint error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
