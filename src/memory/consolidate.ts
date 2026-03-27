import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { LLMClient } from '../llm/client';
import { EpisodeBuffer } from './buffer';
import { DecayEngine } from './decay';
import { RelationshipManager } from './relationships';
import {
  buildConsolidationPrompt,
  buildSemanticPrompt,
  buildRelationshipPrompt,
} from '../agent/prompts';
import { EpisodeBufferEntry, EpisodicMemory, LocationId, Relationship } from '../types';

interface ConsolidationResult {
  episodes_created: number;
  semantics_created: number;
  relationships_updated: number;
  memories_archived: { episodic: number; semantic: number };
}

const ZERO_RESULT: ConsolidationResult = {
  episodes_created: 0,
  semantics_created: 0,
  relationships_updated: 0,
  memories_archived: { episodic: 0, semantic: 0 },
};

export class ConsolidationEngine {
  private db: Database.Database;
  private llm: LLMClient | null;
  private buffer: EpisodeBuffer;
  private decay: DecayEngine;
  private relationships: RelationshipManager;

  constructor(
    db: Database.Database,
    llm: LLMClient | null,
    buffer: EpisodeBuffer,
    decay: DecayEngine,
    relationships: RelationshipManager,
  ) {
    this.db = db;
    this.llm = llm;
    this.buffer = buffer;
    this.decay = decay;
    this.relationships = relationships;
  }

  /**
   * Main consolidation for one agent at end of day.
   * Forms episodic and semantic memories from the episode buffer,
   * updates relationships, applies decay, and clears the buffer.
   */
  async consolidateDay(
    agentId: string,
    agentName: string,
    day: number,
  ): Promise<ConsolidationResult> {
    // ---------------------------------------------------------------
    // Step 1: Get day's raw events from buffer
    // ---------------------------------------------------------------
    const dayEntries = this.buffer.getDayEntries(agentId, day);
    if (dayEntries.length === 0) {
      // Still run decay even if no events
      const archived = this.decay.applyDecay(agentId, day);
      return {
        ...ZERO_RESULT,
        memories_archived: {
          episodic: archived.episodic_archived,
          semantic: archived.semantic_archived,
        },
      };
    }

    // No-LLM mode: skip all LLM calls, just decay + clear
    if (!this.llm) {
      const archived = this.decay.applyDecay(agentId, day);
      this.buffer.clearDay(agentId, day);
      return {
        ...ZERO_RESULT,
        memories_archived: {
          episodic: archived.episodic_archived,
          semantic: archived.semantic_archived,
        },
      };
    }

    const dayEventsText = this.formatBufferEntries(dayEntries);
    const defaultLocation: LocationId = dayEntries[0]?.location ?? 'RIVER';

    let episodesCreated = 0;
    let semanticsCreated = 0;
    let relationshipsUpdated = 0;
    const createdEpisodes: Array<{ summary: string; entities: string[]; tags: string[] }> = [];

    // ---------------------------------------------------------------
    // Step 2: Episode slicing (LLM call)
    // ---------------------------------------------------------------
    try {
      const recentMemories = this.getRecentEpisodicMemories(agentId);
      const recentMemoriesText = recentMemories
        .map((m) => `[Day ${m.day}] ${m.summary} (tags: ${m.tags})`)
        .join('\n');

      const promptJson = buildConsolidationPrompt(agentName, dayEventsText, recentMemoriesText);
      const { system, user } = JSON.parse(promptJson);

      const episodes = await this.llm.callJson<
        Array<{
          summary: string;
          entities?: string[];
          emotion_valence?: number;
          emotion_arousal?: number;
          importance?: number;
          tags?: string[];
        }>
      >({
        model: 'haiku',
        systemPrompt: system,
        userPrompt: user,
        maxTokens: 1024,
      });

      if (Array.isArray(episodes)) {
        const insertStmt = this.db.prepare(
          `INSERT INTO episodic_memory
            (id, agent_id, day, summary, entities, location, emotion_valence, emotion_arousal,
             importance, stm_strength, ltm_strength, tags, causal_links)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0, 0.3, ?, ?)`,
        );

        for (const ep of episodes) {
          const id = uuidv4();
          const entities = Array.isArray(ep.entities) ? ep.entities : [];
          const tags = Array.isArray(ep.tags) ? ep.tags : [];
          // Clamp values to valid ranges
          const rawValence = typeof ep.emotion_valence === 'number' ? ep.emotion_valence : 0;
          const valence = Math.max(-1, Math.min(1, rawValence));
          const rawArousal = typeof ep.emotion_arousal === 'number' ? ep.emotion_arousal : 0.3;
          const arousal = Math.max(0, Math.min(1, rawArousal));
          const rawImportance = typeof ep.importance === 'number' ? ep.importance : 5;
          // Normalize importance: if LLM returns 1-10 scale, divide by 10
          const importance = rawImportance > 1 ? Math.max(0, Math.min(1, rawImportance / 10)) : Math.max(0, Math.min(1, rawImportance));

          insertStmt.run(
            id,
            agentId,
            day,
            ep.summary ?? 'Unknown episode',
            JSON.stringify(entities),
            defaultLocation,
            valence,
            arousal,
            importance,
            JSON.stringify(tags),
            JSON.stringify([]),
          );

          createdEpisodes.push({ summary: ep.summary ?? '', entities, tags });
          episodesCreated++;
        }
      }
    } catch (err) {
      console.error(`[Consolidation] Episode slicing failed for ${agentName} day ${day}:`, err);
    }

    // ---------------------------------------------------------------
    // Step 3: Semantic extraction (LLM call)
    // ---------------------------------------------------------------
    try {
      const existingSemantics = this.getExistingSemantics(agentId);
      const existingSemanticsText = existingSemantics
        .map((s) => `[${s.category}] ${s.content} (confidence: ${s.confidence})`)
        .join('\n');

      // Get known agent IDs for contradiction detection
      const allTargets = (this.db.prepare(
        `SELECT DISTINCT target_id FROM relationships WHERE agent_id = ?`
      ).all(agentId) as any[]).map((r: any) => r.target_id as string);

      const dayEpisodesText = createdEpisodes
        .map((ep) => `- ${ep.summary} (tags: ${ep.tags.join(', ')})`)
        .join('\n');

      const promptJson = buildSemanticPrompt(agentName, dayEpisodesText, existingSemanticsText);
      const { system, user } = JSON.parse(promptJson);

      const facts = await this.llm.callJson<
        Array<{
          content: string;
          category?: 'fact' | 'rule' | 'skill' | 'preference';
          confidence?: number;
          source_episode_summary?: string;
        }>
      >({
        model: 'haiku',
        systemPrompt: system,
        userPrompt: user,
        maxTokens: 1024,
      });

      if (Array.isArray(facts)) {
        for (const fact of facts) {
          if (!fact.content) continue;

          const contentHash = createHash('sha256')
            .update(fact.content.toLowerCase().trim())
            .digest('hex');

          const existing = this.db
            .prepare(
              `SELECT id, confidence FROM semantic_memory
               WHERE agent_id = ? AND content_hash = ?`,
            )
            .get(agentId, contentHash) as
            | { id: string; confidence: number }
            | undefined;

          if (existing) {
            // Reinforce existing knowledge
            const newConfidence = Math.min(1.0, existing.confidence + 0.1);
            this.db
              .prepare(
                `UPDATE semantic_memory
                 SET confidence = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
              )
              .run(newConfidence, existing.id);
          } else {
            // Insert new semantic memory
            const id = uuidv4();
            const category = fact.category ?? 'fact';
            const confidence = typeof fact.confidence === 'number' ? Math.min(1.0, Math.max(0, fact.confidence)) : 0.5;
            const sourceEpisodes = fact.source_episode_summary
              ? [fact.source_episode_summary]
              : [];

            // Contradiction detection: if new fact is about an entity and
            // contradicts existing facts about that entity, reduce old confidence
            const contentLower = fact.content.toLowerCase();
            const negativeMarkers = ['not', 'never', 'don\'t', 'cannot', 'untrust', 'dishonest', 'stole', 'steal', 'betray', 'lied', 'lie', 'no longer'];
            const positiveMarkers = ['trust', 'reliable', 'generous', 'helpful', 'cooperat', 'honest', 'dependable', 'kind'];
            const isNegative = negativeMarkers.some(m => contentLower.includes(m));
            const isPositive = positiveMarkers.some(m => contentLower.includes(m)) && !isNegative;

            if (isNegative || isPositive) {
              // Find existing semantic memories that contradict this one
              const existingFacts = this.db.prepare(
                `SELECT id, content, confidence FROM semantic_memory WHERE agent_id = ? AND category = 'fact'`
              ).all(agentId) as Array<{ id: string; content: string; confidence: number }>;

              for (const ef of existingFacts) {
                const efLower = ef.content.toLowerCase();
                // Check if they share an entity reference
                const sharedEntity = allTargets?.some((t: string) =>
                  contentLower.includes(t.toLowerCase()) && efLower.includes(t.toLowerCase())
                );
                if (!sharedEntity) continue;

                const efIsNeg = negativeMarkers.some(m => efLower.includes(m));
                const efIsPos = positiveMarkers.some(m => efLower.includes(m)) && !efIsNeg;

                // If opposing sentiment about the same entity, reduce old confidence
                if ((isNegative && efIsPos) || (isPositive && efIsNeg)) {
                  const reducedConf = Math.max(0.1, ef.confidence - 0.3);
                  this.db.prepare(
                    `UPDATE semantic_memory SET confidence = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
                  ).run(reducedConf, ef.id);
                }
              }
            }

            this.db
              .prepare(
                `INSERT INTO semantic_memory
                  (id, agent_id, content, category, confidence, source_episodes,
                   stm_strength, ltm_strength, content_hash)
                 VALUES (?, ?, ?, ?, ?, ?, 1.0, 0.3, ?)`,
              )
              .run(
                id,
                agentId,
                fact.content,
                category,
                confidence,
                JSON.stringify(sourceEpisodes),
                contentHash,
              );

            semanticsCreated++;
          }
        }
      }
    } catch (err) {
      console.error(`[Consolidation] Semantic extraction failed for ${agentName} day ${day}:`, err);
    }

    // ---------------------------------------------------------------
    // Step 4: Relationship updates (LLM call per encountered agent)
    // ---------------------------------------------------------------
    try {
      const encounteredAgents = new Set<string>();
      // Pull entities from raw buffer entries
      for (const entry of dayEntries) {
        for (const entity of entry.entities) {
          if (entity !== agentId) encounteredAgents.add(entity);
        }
      }
      // Also pull entities from consolidated episodes (LLM may extract new ones)
      for (const ep of createdEpisodes) {
        for (const entity of ep.entities) {
          if (entity !== agentId && entity !== agentName) encounteredAgents.add(entity);
        }
      }
      // Also scan episode summaries for known agent names/ids
      const allKnownAgents = (this.db.prepare(
        `SELECT DISTINCT agent_id FROM relationships WHERE agent_id = ? OR target_id = ?`
      ).all(agentId, agentId) as any[]).map(r => r.agent_id);
      const allTargets = (this.db.prepare(
        `SELECT DISTINCT target_id FROM relationships WHERE agent_id = ?`
      ).all(agentId) as any[]).map(r => r.target_id);
      for (const targetId of allTargets) {
        if (targetId === agentId) continue;
        const mentioned = createdEpisodes.some(ep =>
          ep.summary.toLowerCase().includes(targetId.toLowerCase())
        ) || dayEntries.some(entry =>
          entry.content.toLowerCase().includes(targetId.toLowerCase())
        );
        if (mentioned) encounteredAgents.add(targetId);
      }

      const dayEpisodesText = createdEpisodes
        .map((ep) => `- ${ep.summary}`)
        .join('\n');

      for (const targetId of encounteredAgents) {
        try {
          const currentRel = this.relationships.getRelationship(agentId, targetId);
          if (!currentRel) continue;

          // Filter episodes involving this target
          const relevantEpisodes = createdEpisodes
            .filter((ep) => ep.entities.includes(targetId))
            .map((ep) => `- ${ep.summary}`)
            .join('\n');

          if (!relevantEpisodes) continue;

          const promptJson = buildRelationshipPrompt(
            agentName,
            targetId,
            relevantEpisodes,
            currentRel,
          );
          const { system, user } = JSON.parse(promptJson);

          const deltas = await this.llm!.callJson<{
            trust_delta?: number;
            fear_delta?: number;
            respect_delta?: number;
            affection_delta?: number;
            rivalry_delta?: number;
            memory_notes?: string;
          }>({
            model: 'haiku',
            systemPrompt: system,
            userPrompt: user,
            maxTokens: 256,
          });

          this.relationships.updateRelationship(
            agentId,
            targetId,
            {
              trust: deltas.trust_delta ?? 0,
              fear: deltas.fear_delta ?? 0,
              respect: deltas.respect_delta ?? 0,
              affection: deltas.affection_delta ?? 0,
              rivalry: deltas.rivalry_delta ?? 0,
              memory_notes: deltas.memory_notes,
            },
            day,
          );

          relationshipsUpdated++;
        } catch (err) {
          console.error(
            `[Consolidation] Relationship update failed for ${agentName} -> ${targetId}:`,
            err,
          );
        }
      }
    } catch (err) {
      console.error(`[Consolidation] Relationship step failed for ${agentName} day ${day}:`, err);
    }

    // ---------------------------------------------------------------
    // Step 5: Apply decay
    // ---------------------------------------------------------------
    const archived = this.decay.applyDecay(agentId, day);

    // ---------------------------------------------------------------
    // Step 6: Clear the buffer
    // ---------------------------------------------------------------
    this.buffer.clearDay(agentId, day);

    // ---------------------------------------------------------------
    // Step 7: Log consolidation
    // ---------------------------------------------------------------
    const stats = {
      episodes_created: episodesCreated,
      semantics_created: semanticsCreated,
      relationships_updated: relationshipsUpdated,
      memories_archived: {
        episodic: archived.episodic_archived,
        semantic: archived.semantic_archived,
      },
    };

    try {
      this.db
        .prepare(
          `INSERT INTO consolidation_log (agent_id, day, type, summary, stats)
           VALUES (?, ?, 'episode', ?, ?)`,
        )
        .run(
          agentId,
          day,
          `Consolidated day ${day}: ${episodesCreated} episodes, ${semanticsCreated} semantics, ${relationshipsUpdated} relationships updated`,
          JSON.stringify(stats),
        );
    } catch (err) {
      console.error(`[Consolidation] Failed to write consolidation log:`, err);
    }

    return stats;
  }

  /**
   * Format buffer entries as a text block for the LLM prompt.
   */
  private formatBufferEntries(entries: EpisodeBufferEntry[]): string {
    return entries
      .map(
        (e) =>
          `[Tick ${e.tick}] (${e.event_type}) ${e.content}` +
          (e.entities.length > 0 ? ` [entities: ${e.entities.join(', ')}]` : ''),
      )
      .join('\n');
  }

  /**
   * Get the top 20 recent episodic memories for causal linking context.
   */
  private getRecentEpisodicMemories(
    agentId: string,
  ): Array<{ summary: string; day: number; tags: string }> {
    return this.db
      .prepare(
        `SELECT summary, day, tags FROM episodic_memory
         WHERE agent_id = ? ORDER BY day DESC LIMIT 20`,
      )
      .all(agentId) as Array<{ summary: string; day: number; tags: string }>;
  }

  /**
   * Get existing semantic memories for deduplication.
   */
  private getExistingSemantics(
    agentId: string,
  ): Array<{ content: string; category: string; confidence: number }> {
    return this.db
      .prepare(
        `SELECT content, category, confidence FROM semantic_memory WHERE agent_id = ?`,
      )
      .all(agentId) as Array<{ content: string; category: string; confidence: number }>;
  }
}
