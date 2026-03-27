import Database from 'better-sqlite3';
import { Relationship } from '../types';

export class RelationshipManager {
  private db: Database.Database;

  // Prepared statements
  private stmtInsert: Database.Statement;
  private stmtGetOne: Database.Statement;
  private stmtGetAll: Database.Statement;
  private stmtGetForTarget: Database.Statement;
  private stmtUpdate: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    this.stmtInsert = db.prepare(`
      INSERT OR IGNORE INTO relationships
        (agent_id, target_id, trust, fear, respect, affection, rivalry,
         interaction_count, last_interaction_day, memory_notes)
      VALUES (?, ?, 0, 0, 0, 0, 0, 0, NULL, '')
    `);

    this.stmtGetOne = db.prepare(`
      SELECT * FROM relationships WHERE agent_id = ? AND target_id = ?
    `);

    this.stmtGetAll = db.prepare(`
      SELECT * FROM relationships WHERE agent_id = ?
    `);

    this.stmtGetForTarget = db.prepare(`
      SELECT * FROM relationships WHERE agent_id = ? AND target_id = ?
    `);

    this.stmtUpdate = db.prepare(`
      UPDATE relationships SET
        trust = ?, fear = ?, respect = ?, affection = ?, rivalry = ?,
        interaction_count = interaction_count + 1,
        last_interaction_day = ?,
        memory_notes = ?
      WHERE agent_id = ? AND target_id = ?
    `);
  }

  initRelationships(agentIds: string[]): void {
    const txn = this.db.transaction((ids: string[]) => {
      for (let i = 0; i < ids.length; i++) {
        for (let j = 0; j < ids.length; j++) {
          if (i !== j) {
            this.stmtInsert.run(ids[i], ids[j]);
          }
        }
      }
    });
    txn(agentIds);
  }

  getRelationship(agentId: string, targetId: string): Relationship | null {
    const row = this.stmtGetOne.get(agentId, targetId) as Relationship | undefined;
    return row ?? null;
  }

  getRelationships(agentId: string): Relationship[] {
    return this.stmtGetAll.all(agentId) as Relationship[];
  }

  getRelationshipsForTargets(agentId: string, targetIds: string[]): Relationship[] {
    const results: Relationship[] = [];
    for (const targetId of targetIds) {
      const row = this.stmtGetForTarget.get(agentId, targetId) as Relationship | undefined;
      if (row) {
        results.push(row);
      }
    }
    return results;
  }

  updateRelationship(
    agentId: string,
    targetId: string,
    deltas: {
      trust?: number;
      fear?: number;
      respect?: number;
      affection?: number;
      rivalry?: number;
      memory_notes?: string;
    },
    day: number
  ): void {
    const current = this.getRelationship(agentId, targetId);
    if (!current) return;

    const clamp = (val: number, min: number, max: number) =>
      Math.min(max, Math.max(min, val));

    const trust = clamp(current.trust + (deltas.trust ?? 0), -1, 1);
    const fear = clamp(current.fear + (deltas.fear ?? 0), 0, 1);
    const respect = clamp(current.respect + (deltas.respect ?? 0), -1, 1);
    const affection = clamp(current.affection + (deltas.affection ?? 0), -1, 1);
    const rivalry = clamp(current.rivalry + (deltas.rivalry ?? 0), 0, 1);
    const memoryNotes = deltas.memory_notes ?? current.memory_notes;

    this.stmtUpdate.run(
      trust, fear, respect, affection, rivalry,
      day, memoryNotes,
      agentId, targetId
    );
  }

  formatForPrompt(relationships: Relationship[]): string {
    const lines: string[] = [];
    for (const rel of relationships) {
      const dims: string[] = [];
      if (rel.trust !== 0) dims.push(`trust: ${rel.trust.toFixed(1)}`);
      if (rel.fear !== 0) dims.push(`fear: ${rel.fear.toFixed(1)}`);
      if (rel.respect !== 0) dims.push(`respect: ${rel.respect.toFixed(1)}`);
      if (rel.affection !== 0) dims.push(`affection: ${rel.affection.toFixed(1)}`);
      if (rel.rivalry !== 0) dims.push(`rivalry: ${rel.rivalry.toFixed(1)}`);

      let line = `${rel.target_id}: ${dims.length > 0 ? dims.join(', ') : 'neutral'}`;
      if (rel.memory_notes) {
        line += ` | "${rel.memory_notes}"`;
      }
      lines.push(line);
    }
    return lines.join('\n');
  }
}
