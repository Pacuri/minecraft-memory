import Database from 'better-sqlite3';
import { RetrievalQuery, ScoredMemory } from '../types';

export class MemoryRetriever {
  private db: Database.Database;

  // Prepared statements
  private stmtTemporal: Database.Statement;
  private stmtEntity: Database.Statement;
  private stmtLocation: Database.Statement;
  private stmtEmotional: Database.Statement;
  private stmtSemantic: Database.Statement;
  private stmtReinforceEpisodic: Database.Statement;
  private stmtReinforceSemantic: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    this.stmtTemporal = db.prepare(`
      SELECT *, (stm_strength + ltm_strength) as combined_strength
      FROM episodic_memory
      WHERE agent_id = ? AND (stm_strength > 0.1 OR ltm_strength > 0.1)
      ORDER BY day DESC, importance DESC
      LIMIT 10
    `);

    this.stmtEntity = db.prepare(`
      SELECT * FROM episodic_memory
      WHERE agent_id = ? AND entities LIKE ?
        AND (stm_strength > 0.1 OR ltm_strength > 0.1)
      ORDER BY importance DESC, day DESC
      LIMIT 5
    `);

    this.stmtLocation = db.prepare(`
      SELECT * FROM episodic_memory
      WHERE agent_id = ? AND location = ?
        AND (stm_strength > 0.1 OR ltm_strength > 0.1)
      ORDER BY importance DESC
      LIMIT 5
    `);

    this.stmtEmotional = db.prepare(`
      SELECT * FROM episodic_memory
      WHERE agent_id = ? AND emotion_arousal > 0.7
        AND (stm_strength > 0.1 OR ltm_strength > 0.1)
      ORDER BY emotion_arousal DESC, importance DESC
      LIMIT 5
    `);

    this.stmtSemantic = db.prepare(`
      SELECT * FROM semantic_memory
      WHERE agent_id = ?
        AND (stm_strength > 0.1 OR ltm_strength > 0.1)
      ORDER BY confidence DESC, ltm_strength DESC
      LIMIT 10
    `);

    this.stmtReinforceEpisodic = db.prepare(`
      UPDATE episodic_memory SET
        stm_strength = MIN(1.0, stm_strength + 0.1),
        ltm_strength = MIN(1.0, ltm_strength + 0.05),
        retrieval_count = retrieval_count + 1,
        last_retrieved_day = ?
      WHERE id = ?
    `);

    this.stmtReinforceSemantic = db.prepare(`
      UPDATE semantic_memory SET
        stm_strength = MIN(1.0, stm_strength + 0.1),
        ltm_strength = MIN(1.0, ltm_strength + 0.05),
        retrieval_count = retrieval_count + 1
      WHERE id = ?
    `);
  }

  retrieve(query: RetrievalQuery): ScoredMemory[] {
    const { agent_id, current_day, current_location, present_agents, budget_tokens } = query;
    const candidates = new Map<string, ScoredMemory>();

    const addCandidate = (mem: any, weight: number, table: 'episodic_memory' | 'semantic_memory') => {
      const score = this.scoreMemory(mem, weight, current_day);
      const content = table === 'episodic_memory' ? mem.summary : mem.content;
      const key = `${table}:${mem.id}`;
      const existing = candidates.get(key);
      if (!existing || existing.score < score) {
        candidates.set(key, {
          id: mem.id,
          table,
          content,
          score,
          day: mem.day,
          emotion_arousal: mem.emotion_arousal,
          importance: mem.importance,
        });
      }
    };

    // Pathway 1 - Temporal recency (weight 0.3)
    const temporalRows = this.stmtTemporal.all(agent_id) as any[];
    for (const row of temporalRows) {
      addCandidate(row, 0.3, 'episodic_memory');
    }

    // Pathway 2 - Entity-based (weight 0.35)
    for (const targetAgentId of present_agents) {
      const entityRows = this.stmtEntity.all(agent_id, `%${targetAgentId}%`) as any[];
      for (const row of entityRows) {
        addCandidate(row, 0.35, 'episodic_memory');
      }
    }

    // Pathway 3 - Location-based (weight 0.15)
    const locationRows = this.stmtLocation.all(agent_id, current_location) as any[];
    for (const row of locationRows) {
      addCandidate(row, 0.15, 'episodic_memory');
    }

    // Pathway 4 - Emotional (weight 0.15)
    const emotionalRows = this.stmtEmotional.all(agent_id) as any[];
    for (const row of emotionalRows) {
      addCandidate(row, 0.15, 'episodic_memory');
    }

    // Pathway 5 - Semantic knowledge (weight 0.2)
    const semanticRows = this.stmtSemantic.all(agent_id) as any[];
    for (const row of semanticRows) {
      addCandidate(row, 0.2, 'semantic_memory');
    }

    // Sort by score descending
    const sorted = Array.from(candidates.values()).sort((a, b) => b.score - a.score);

    // Fill token budget (~20 tokens per memory)
    const maxMemories = Math.floor(budget_tokens / 20);
    const selected = sorted.slice(0, maxMemories);

    // Reinforce selected memories (retrieval = rehearsal)
    const reinforceTxn = this.db.transaction((memories: ScoredMemory[]) => {
      for (const mem of memories) {
        this.reinforceMemory(mem.id, mem.table, current_day);
      }
    });
    reinforceTxn(selected);

    return selected;
  }

  private scoreMemory(mem: any, pathwayWeight: number, currentDay: number): number {
    const stm = Math.max(0, Math.min(1, mem.stm_strength ?? 0));
    const ltm = Math.max(0, Math.min(1, mem.ltm_strength ?? 0));
    const strength = stm * 0.6 + ltm * 0.4;
    const recency = Math.exp(-((currentDay - (mem.day ?? currentDay)) / 10));
    const arousal = Math.max(0, Math.min(1, mem.emotion_arousal || 0));
    const importance = Math.max(0, Math.min(1, mem.importance || 0));
    const emotionalBoost = 1 + arousal * 0.5;
    const importanceBoost = 1 + importance * 0.3;
    return pathwayWeight * strength * recency * emotionalBoost * importanceBoost;
  }

  private reinforceMemory(
    id: string,
    table: 'episodic_memory' | 'semantic_memory',
    currentDay: number
  ): void {
    if (table === 'episodic_memory') {
      this.stmtReinforceEpisodic.run(currentDay, id);
    } else {
      this.stmtReinforceSemantic.run(id);
    }
  }
}
