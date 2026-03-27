import Database from 'better-sqlite3';
import { LLMClient } from '../llm/client';
import { buildIdentityPrompt } from '../agent/prompts';
import { IdentityCore } from '../types';

export class IdentityManager {
  private db: Database.Database;
  private llm: LLMClient;

  // Prepared statements (lazily initialized)
  private stmtInit!: Database.Statement;
  private stmtGet!: Database.Statement;
  private stmtUpdateIdentity!: Database.Statement;
  private stmtUpdateBonds!: Database.Statement;
  private stmtRecentMemories!: Database.Statement;
  private stmtRecentRelationships!: Database.Statement;
  private stmtTopBonds!: Database.Statement;
  private stmtExportMemories!: Database.Statement;
  private stmtExportRelationships!: Database.Statement;
  private stmtLogConsolidation!: Database.Statement;
  private prepared = false;

  constructor(db: Database.Database, llm: LLMClient) {
    this.db = db;
    this.llm = llm;
  }

  private ensurePrepared(): void {
    if (this.prepared) return;

    this.stmtInit = this.db.prepare(`
      INSERT OR IGNORE INTO identity_core (agent_id, personality, principles, narrative, core_bonds, last_updated_day)
      VALUES (?, ?, '[]', '', '[]', 0)
    `);

    this.stmtGet = this.db.prepare(`
      SELECT agent_id, personality, principles, narrative, core_bonds, last_updated_day
      FROM identity_core WHERE agent_id = ?
    `);

    this.stmtUpdateIdentity = this.db.prepare(`
      UPDATE identity_core
      SET personality = ?, principles = ?, narrative = ?, last_updated_day = ?
      WHERE agent_id = ?
    `);

    this.stmtUpdateBonds = this.db.prepare(`
      UPDATE identity_core SET core_bonds = ? WHERE agent_id = ?
    `);

    this.stmtRecentMemories = this.db.prepare(`
      SELECT summary, day, emotion_valence, emotion_arousal, importance, tags
      FROM episodic_memory
      WHERE agent_id = ? AND day > ?
      ORDER BY (importance * (stm_strength + ltm_strength)) DESC
      LIMIT 15
    `);

    this.stmtRecentRelationships = this.db.prepare(`
      SELECT * FROM relationships WHERE agent_id = ? AND last_interaction_day > ?
    `);

    this.stmtTopBonds = this.db.prepare(`
      SELECT * FROM relationships WHERE agent_id = ?
      ORDER BY (ABS(trust) + ABS(affection)) DESC
      LIMIT 3
    `);

    this.stmtExportMemories = this.db.prepare(`
      SELECT * FROM episodic_memory WHERE agent_id = ?
      ORDER BY ltm_strength DESC
      LIMIT 50
    `);

    this.stmtExportRelationships = this.db.prepare(`
      SELECT * FROM relationships WHERE agent_id = ?
    `);

    this.stmtLogConsolidation = this.db.prepare(`
      INSERT INTO consolidation_log (agent_id, day, type, input_count, output_summary)
      VALUES (?, ?, 'identity', ?, ?)
    `);

    this.prepared = true;
  }

  /**
   * Initialize identity core for an agent from their personality seed.
   */
  initIdentity(agentId: string, personalitySeed: string): void {
    this.ensurePrepared();
    this.stmtInit.run(agentId, personalitySeed);
  }

  /**
   * Get the current identity for an agent.
   * Returns null if not found.
   */
  getIdentity(agentId: string): IdentityCore | null {
    this.ensurePrepared();
    const row = this.stmtGet.get(agentId) as any;
    if (!row) return null;

    return {
      agent_id: row.agent_id,
      personality: row.personality,
      principles: JSON.parse(row.principles),
      narrative: row.narrative,
      core_bonds: JSON.parse(row.core_bonds),
      last_updated_day: row.last_updated_day,
    };
  }

  /**
   * Consolidate identity (every 10 days) -- uses Sonnet for narrative quality.
   * If the LLM call fails, the existing identity is preserved.
   */
  async consolidateIdentity(agentId: string, agentName: string, day: number): Promise<void> {
    this.ensurePrepared();

    // 1. Get current identity
    const identity = this.getIdentity(agentId);
    if (!identity) {
      console.warn(`[IdentityManager] No identity found for agent ${agentId}, skipping consolidation.`);
      return;
    }

    // 2. Get top 15 episodic memories from last 10 days
    const lookbackDay = day - 10;
    const recentMemories = this.stmtRecentMemories.all(agentId, lookbackDay) as any[];

    // 3. Get relationship changes from last 10 days
    const recentRelationships = this.stmtRecentRelationships.all(agentId, lookbackDay) as any[];

    // 4. Format strong memories as text
    const strongMemoriesText = recentMemories.length > 0
      ? recentMemories.map((m) => {
          const tags = typeof m.tags === 'string' ? m.tags : JSON.stringify(m.tags);
          return `- [Day ${m.day}] ${m.summary} (importance: ${m.importance}, valence: ${m.emotion_valence}, arousal: ${m.emotion_arousal}, tags: ${tags})`;
        }).join('\n')
      : '';

    // Format relationship deltas as text
    const relationshipDeltasText = recentRelationships.length > 0
      ? recentRelationships.map((r) =>
          `Relationship with ${r.target_id}: trust ${r.trust}, respect ${r.respect}, fear ${r.fear}, affection ${r.affection}, rivalry ${r.rivalry}`
        ).join('\n')
      : '';

    try {
      // 5. Call llm.callJson() with model 'sonnet' using buildIdentityPrompt
      const promptData = JSON.parse(buildIdentityPrompt(agentName, identity, strongMemoriesText, relationshipDeltasText));

      const result = await this.llm.callJson<{
        personality: string;
        principles: string[];
        narrative: string;
      }>({
        model: 'sonnet',
        systemPrompt: promptData.system,
        userPrompt: promptData.user,
        maxTokens: 1024,
      });

      // 6. Validate response shape
      const personality = typeof result.personality === 'string' ? result.personality : identity.personality;
      const principles = Array.isArray(result.principles) ? result.principles : identity.principles;
      const narrative = typeof result.narrative === 'string' ? result.narrative : identity.narrative;

      // 7. Update identity_core
      this.stmtUpdateIdentity.run(
        personality,
        JSON.stringify(principles),
        narrative,
        day,
        agentId,
      );

      // 8. Update core_bonds from current relationships (top 3 by |trust| + |affection|)
      const topBonds = this.stmtTopBonds.all(agentId) as any[];
      const coreBonds = topBonds.map((r) => ({
        target: r.target_id,
        nature: r.memory_notes || '',
        strength: r.trust + r.affection,
      }));
      this.stmtUpdateBonds.run(JSON.stringify(coreBonds), agentId);

      // 9. Log to consolidation_log
      const outputSummary = `personality updated, ${principles.length} principles, narrative ${narrative.length} chars`;
      this.stmtLogConsolidation.run(agentId, day, recentMemories.length, outputSummary);

    } catch (error: any) {
      console.error(
        `[IdentityManager] Failed to consolidate identity for ${agentId} on day ${day}: ${error.message ?? error}. Keeping existing identity.`
      );
    }
  }

  /**
   * Export identity for cross-sim portability.
   * Returns a portable bundle with identity, top memories, and all relationships.
   */
  exportIdentity(agentId: string): { identity: IdentityCore; top_memories: any[]; relationships: any[] } | null {
    this.ensurePrepared();

    const identity = this.getIdentity(agentId);
    if (!identity) return null;

    const topMemories = this.stmtExportMemories.all(agentId) as any[];
    const relationships = this.stmtExportRelationships.all(agentId) as any[];

    return {
      identity,
      top_memories: topMemories,
      relationships,
    };
  }
}
