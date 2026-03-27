import Database from 'better-sqlite3';

export class DecayEngine {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Apply daily decay to all memories for an agent.
   *
   * Episodic memories:
   *   - Non-emotional (arousal <= 0.5): STM τ=3, LTM τ=30
   *   - Emotional (arousal > 0.5):      STM τ=3+arousal*3, LTM τ=30+arousal*25
   *
   * Semantic memories: STM τ=10, LTM τ=60
   *
   * Memories whose both strengths drop below 0.05 are archived (deleted).
   */
  applyDecay(
    agentId: string,
    currentDay: number,
  ): { episodic_archived: number; semantic_archived: number } {
    const result = this.db.transaction(() => {
      // Step 1a: Decay non-emotional episodic memories (base rates)
      this.db
        .prepare(
          `UPDATE episodic_memory
           SET stm_strength = stm_strength * EXP(-1.0 / 3.0),
               ltm_strength = ltm_strength * EXP(-1.0 / 30.0)
           WHERE agent_id = ? AND emotion_arousal <= 0.5`,
        )
        .run(agentId);

      // Step 1b: Decay emotional episodic memories (boosted τ values)
      this.db
        .prepare(
          `UPDATE episodic_memory
           SET stm_strength = stm_strength * EXP(-1.0 / (3.0 + emotion_arousal * 3.0)),
               ltm_strength = ltm_strength * EXP(-1.0 / (30.0 + emotion_arousal * 25.0))
           WHERE agent_id = ? AND emotion_arousal > 0.5`,
        )
        .run(agentId);

      // Step 2: Decay semantic memories (slower rates)
      this.db
        .prepare(
          `UPDATE semantic_memory
           SET stm_strength = stm_strength * EXP(-1.0 / 10.0),
               ltm_strength = ltm_strength * EXP(-1.0 / 60.0)
           WHERE agent_id = ?`,
        )
        .run(agentId);

      // Step 3: Archive dead memories (both strengths below threshold)
      const episodicResult = this.db
        .prepare(
          `DELETE FROM episodic_memory
           WHERE agent_id = ? AND stm_strength < 0.05 AND ltm_strength < 0.05`,
        )
        .run(agentId);

      const semanticResult = this.db
        .prepare(
          `DELETE FROM semantic_memory
           WHERE agent_id = ? AND stm_strength < 0.05 AND ltm_strength < 0.05`,
        )
        .run(agentId);

      return {
        episodic_archived: episodicResult.changes,
        semantic_archived: semanticResult.changes,
      };
    })();

    return result;
  }
}
