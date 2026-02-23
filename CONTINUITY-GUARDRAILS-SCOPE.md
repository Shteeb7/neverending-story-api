# Story Continuity Guardrails — Option C Scope

**Status:** Phase 1 COMPLETE (deployed). Phase 2 pending. Phase 3 (Prospero's Editor) in design.
**Date:** February 22, 2026 (updated February 23, 2026)
**Origin:** Suite 2 testing + deep dive on AI storytelling continuity

---

## Problem Statement

Over 12 chapters generated in 4 batches (1-3, 4-6, 7-9, 10-12), Claude sometimes introduces names, actions, dialogue, or world facts that contradict what was established earlier. This is especially pronounced at batch boundaries where context switches. The current story bible and character ledger reduce this but don't eliminate it.

Known examples: Priya Chakraborty → Priya Sharma (name drift across sequel), theme duplication in sequel bibles (fixed separately).

## Solution: Two-Layer Continuity System

### Layer 1 — Silent Post-Generation Validation

After each chapter is generated, before it's delivered to the user, run an automated consistency check.

**What it checks:**

1. **Character name/appearance consistency** — Every character mentioned in the new chapter is cross-referenced against the story bible. Names, physical descriptions, relationships, and locations must match canonical data.

2. **World rule violations** — Magic system rules, technology constraints, geography, and timeline logic checked against established facts.

3. **Plot thread continuity** — Open subplots tracked across chapters. New chapter can't contradict resolved threads or ignore critical unresolved ones.

4. **Coreference resolution** — Pronouns ("he", "she", "they") resolve correctly to the right characters, especially in multi-character scenes.

**How it works:**

- Lightweight Claude call (Haiku or Sonnet, not Opus) with the new chapter text + story bible + structured summary of previous chapters
- Decomposed validation: one focused check per category, not a vague "is this consistent?"
- Returns structured JSON: `{ character_issues: [], world_issues: [], plot_issues: [], severity: "none|minor|critical" }`
- If severity = critical: trigger surgical revision of the specific passage (targeted rewrite, not full chapter regeneration)
- If severity = minor: log it but deliver the chapter (flag for monitoring)
- If severity = none: deliver as-is

**Data model addition:**

```
chapter_validations:
  - id (uuid)
  - chapter_id (fk → chapters)
  - story_id (fk → stories)
  - validation_result (jsonb) — full structured output
  - severity (text) — none, minor, critical
  - auto_revised (boolean) — whether a surgical fix was applied
  - revision_diff (text) — what changed, if anything
  - created_at (timestamp)
```

**Cost estimate:** ~$0.01-0.03 per chapter validation using Haiku. For a 12-chapter book: ~$0.12-0.36 total. Negligible vs. the $15-25 generation cost.

### Layer 2 — Prospero's Editor (User-Facing)

The reader becomes a collaborator. When they spot something questionable in the text, they can consult Prospero directly — in-world, in-character, in seconds. This is NOT "report a bug." This is the reader helping shape their story.

**Core design principles:**

1. **Maintain the magic.** The reader never feels like they're doing QA on an AI. They feel like a co-author consulting their storyteller. Prospero is delighted by sharp-eyed readers, never embarrassed by errors.
2. **Fast and frictionless.** The entire interaction — highlight, describe, investigate, resolve — must take seconds, not minutes. No voice sessions, no lengthy dialogues. Text-only, sharp, to the point.
3. **No rate limiting.** Every interaction has value. If the reader is "overusing" it, they're getting personalized passage explanations from Prospero — that's a feature, not abuse. Every interaction generates data for improving the generation engine.
4. **Corrections are permanent.** The chapter content is updated in the database. Logged for rollback if needed, but the fix persists across sessions.
5. **Author-only editing.** Only the user who created the story can trigger corrections. WhisperNet readers can highlight and get Prospero's explanation, and their flags are logged and surfaced to the original author for consideration — but they cannot edit someone else's story.

**UX flow:**

**A. Highlight** — Reader touches and drags to select text, identical to the standard iOS text selection gesture they already know for copy/paste.

**B. Context menu** — A mini menu appears with two options:
  - **"Prospero"** — consult the storyteller about this passage
  - **"Copy"** — standard copy behavior (expected, familiar)

**C. Prospero dialogue** — A compact text chat interface appears (NOT full-screen, NOT voice). Prospero asks a brief, in-character question about what caught the reader's eye. The reader types a short description: "Her eyes were green in chapter 2 but now they're brown" or "The timeline doesn't add up here."

**D. Investigation** — Prospero investigates immediately (single Haiku call). Context sent: highlighted text, surrounding paragraph, relevant story bible entries, entity ledger for related characters/locations, prior chapter references. Target response time: 2-4 seconds.

**E. Resolution — two paths:**

  - **Reader is right (genuine inconsistency):** Prospero responds with delight, not apology. Tone: *"Sharp eye! The threads of this tale tangled here. Let me set them right..."* Reader confirms the fix. The correction animates in real-time — old text dissolves character by character, new text types itself into place. Accompanied by haptic feedback and visual effects (light particles / bubbles reminiscent of the DNA Transfer animation, reinforcing that this is the reader's contribution to the story). Prospero delivers a brief closing line — *"The tale is mended. Read on."* — and the dialogue dismisses automatically. Reader's eye returns to the corrected text.

  - **Reader is wrong (text is actually consistent):** Prospero explains why the passage is accurate, using an in-world explanation, not a technical one. Not "the name is consistent across chapters" but *"Recall that Elara took her mother's name after the ceremony in Chapter 3..."* The reader learns something about their own story. No text changes. Dialogue dismisses.

**F. Backend logging** — Every interaction is logged regardless of outcome:
  - Highlighted text and position (chapter, paragraph, character offset)
  - What the reader said was wrong (their description)
  - Prospero's investigation result (validated against bible + entities)
  - Whether Prospero agreed or disagreed
  - If corrected: original text, corrected text, which bible/entity entry it violated
  - Pattern tags (name_inconsistency, timeline_error, physical_description_drift, world_rule_violation, etc.)
  - Reader contribution tracking: cumulative count of successful catches per user per story, fed into Prospero interview context so rightful praise can be given at checkpoints

**Prospero's character in this mode:**

Prospero stays fully in character but is sharp and concise — no monologues, no theatrical speeches. Think: a master craftsman who respects the reader's intelligence. Brief, warm, impressed when the reader catches something. Never defensive. His responses should be 1-2 sentences, not paragraphs. He can get long-winded in other contexts; here he must be efficient because the reader is mid-chapter and wants to get back to reading.

**Data model:**

```
reader_corrections:
  - id (uuid, PK)
  - user_id (fk → users) — who flagged it
  - author_id (fk → users) — who owns the story (same as user_id for author, different for WhisperNet)
  - story_id (fk → stories)
  - chapter_id (fk → chapters)
  - chapter_number (int)
  - highlighted_text (text) — exact text the reader selected
  - highlight_start (int) — character offset in chapter content
  - highlight_end (int) — character offset in chapter content
  - reader_description (text) — what the reader said was wrong
  - prospero_response (text) — Prospero's in-character response
  - investigation_result (jsonb) — full structured validation output
  - was_corrected (boolean) — whether text was actually changed
  - original_text (text) — pre-correction text (null if no change)
  - corrected_text (text) — post-correction text (null if no change)
  - correction_category (text) — name_inconsistency, timeline_error, description_drift, world_rule, plot_thread, other
  - is_author (boolean) — true if flagged by story author, false if WhisperNet reader
  - author_reviewed (boolean) — for WhisperNet flags: has the author seen this?
  - author_accepted (boolean) — for WhisperNet flags: did the author accept the correction?
  - model_used (text)
  - input_tokens (int)
  - output_tokens (int)
  - investigation_time_ms (int)
  - created_at (timestamp)
```

```
reader_contribution_stats:
  - id (uuid, PK)
  - user_id (fk → users)
  - story_id (fk → stories)
  - total_flags (int, default 0) — total times they consulted Prospero
  - successful_catches (int, default 0) — times Prospero agreed and corrected
  - explanations_received (int, default 0) — times Prospero explained why text was correct
  - categories_caught (jsonb) — { name_inconsistency: 2, timeline_error: 1, ... }
  - updated_at (timestamp)
```

**Feature discovery:**

**A. Prospero introduces it during the first book's chapter 2 checkpoint interview.** Before the checkpoint, query `reader_contribution_stats` for any rows for this user across all stories. If none exist, this is their first book — inject a line into Prospero's checkpoint system prompt telling him to mention the feature naturally: something like *"Should you ever find a thread that seems out of place — a name, a detail that doesn't quite fit — simply highlight the passage and call on me. I welcome a sharp-eyed reader."* One line, in character, feels like an invitation, not a tutorial. On subsequent books, Prospero skips this — the reader already knows.

**B. Natural discovery through existing behavior.** The "Prospero" option appears in the text selection context menu alongside "Copy." Readers who highlight text for any reason (copy a quote, look something up) will see it. No tooltip, no tutorial overlay, no onboarding screen. The feature reveals itself through normal interaction.

**C. Peggy as a fallback discovery path.** If a reader goes to Peggy with a story content complaint (wrong name, plot hole, inconsistency — vs. a technical bug like a crash or loading error), Peggy detects the complaint type and responds: *"It sounds like you found something off in your story. Did you know you can highlight any passage while reading and ask Prospero about it directly? He can investigate and fix it on the spot."* Peggy still logs the complaint normally. Classification is lightweight — keyword matching on the user's message. Mentions of names, characters, plot, chapter, story, "doesn't make sense" → story content → mention Prospero's Editor. Mentions of crash, loading, error, screen, button → technical → handle normally.

**Learning loop — how correction data improves future generation:**

**Layer A — Pattern injection into generation prompts (implement first).** Before generating a new book, query `reader_corrections` for this user's past stories. If patterns emerge (e.g., 4 name inconsistencies across their books), add an explicit instruction to the generation prompt: *"This reader has a sharp eye for character names. Double-check every name reference against the bible before using it."* Costs nothing extra — just a few lines added to the existing prompt. The generation model self-corrects based on known weak spots.

**Layer B — Global error pattern analysis (periodic).** A scheduled job (weekly or on-demand) aggregates `reader_corrections` across ALL users and identifies systemic patterns. If 60% of corrections are `name_inconsistency` at batch boundaries (chapters 4 and 7), that tells us the batch transition prompt needs work. If `timeline_error` spikes in complex-plot stories, maybe the bible needs a dedicated timeline section. This informs prompt engineering and pipeline decisions — could surface as a dashboard tab or periodic report.

**Layer C — Fine-tuned validation rules (long game).** The entity validation system (Phase 1) uses a generic prompt. Over time, build a library of specific validation rules drawn from real corrections: "Always verify character eye color when they reappear after 2+ chapters of absence." "Check that travel times between locations are consistent with established geography." These rules get injected into the Haiku validation prompt, making it smarter without changing the generation model.

---

## Supporting Infrastructure Changes

### Enhanced Story Bible (for both layers)

Add explicit constraint blocks to the bible that get injected into generation prompts:

- **Character aliases** — official name, valid references, forbidden aliases
- **Forbidden contradictions** — explicit list of facts that must not be violated
- **Required callbacks** — each new chapter must reference at least one detail from previous chapters

### Batch Boundary Continuity Summaries

After each 3-chapter batch completes, generate a structured continuity summary (separate from the editor brief) that captures:

- Character states at end of batch (location, emotional state, knowledge)
- Open plot threads with status
- World facts established or modified
- Promises made to the reader (foreshadowing, cliffhangers)

This summary feeds into the next batch's generation prompt AND into the validation layer.

### Entity Extraction Table

```
chapter_entities:
  - id (uuid)
  - chapter_id (fk → chapters)
  - entity_type (text) — character, location, world_rule, timeline, plot_thread
  - entity_name (text)
  - fact (text) — what's stated about this entity
  - source_quote (text) — the actual prose
  - canonical_value (text) — what the bible says
  - is_consistent (boolean)
  - created_at (timestamp)
```

Populated by the post-generation entity extraction pass. Used by both validation layers.

---

## Implementation Priority

**Phase 1 — COMPLETE (Feb 23, 2026):** Silent validation layer (Layer 1) + entity extraction. Haiku validates every chapter post-generation against story bible and prior chapter entities. Critical inconsistencies get surgical revision automatically. Tables: `chapter_validations`, `chapter_entities`. Integrated into `generateChapter()` pipeline in generation.js.

**Phase 2 (next):** Enhanced story bible with constraint injection and batch boundary summaries. Prevents issues at generation time rather than catching them after.

**Phase 3 — Prospero's Editor (Layer 2):** Full reader-facing collaboration feature. Requires:
  - **iOS:** Text selection override in BookReaderView, "Prospero" context menu, compact text chat dialogue, real-time text correction animation (character-by-character dissolve/retype), haptic feedback, DNA Transfer-style visual effects (light particles/bubbles)
  - **API:** Investigation endpoint (Haiku call with highlighted text + bible + entities), correction endpoint (update chapter content + log), reader contribution stats tracking
  - **Database:** `reader_corrections` table, `reader_contribution_stats` table
  - **Prospero prompt:** Concise, in-character, sharp — 1-2 sentence responses max. Delighted by catches, never defensive. In-world explanations when reader is wrong.
  - **Feature discovery:** First-book chapter 2 checkpoint prompt injection (query `reader_contribution_stats` for existence), Peggy story-content classifier to redirect to Prospero's Editor
  - **Learning loop (Layer A):** Query past `reader_corrections` before generation, inject pattern-based warnings into generation prompts

---

## API Cost Considerations

Every new Claude call adds cost. This scope document intentionally does not specify which model to use for each call — that decision is covered by the separate API optimization audit. The validation and entity extraction calls are candidates for Haiku (cheapest) since they're structured data tasks, not creative generation.

---

## Research Sources

- Anthropic prompt caching documentation
- Sudowrite chapter continuity system
- SCORE (Story Coherence and Retrieval Enhancement) — 2025 paper
- NovelAI/KoboldAI community entity tracking approaches
- Book-Agent novel generation pipeline (Level1Techs)
