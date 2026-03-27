import Database from 'better-sqlite3';
import { EpisodeBufferEntry, LocationId } from '../types';

export class EpisodeBuffer {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.insertStmt = db.prepare(
      `INSERT INTO episode_buffer (agent_id, day, tick, event_type, content, entities, location)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
  }

  /** Write a single buffer entry. */
  write(entry: EpisodeBufferEntry): void {
    this.insertStmt.run(
      entry.agent_id,
      entry.day,
      entry.tick,
      entry.event_type,
      entry.content,
      JSON.stringify(entry.entities),
      entry.location,
    );
  }

  /** Write perception + action + outcome as 3 entries for a tick. */
  writeTickExperience(
    agentId: string,
    day: number,
    tick: number,
    location: LocationId,
    perception: string,
    action: string,
    outcome: string,
    entities: string[],
  ): void {
    this.write({
      agent_id: agentId,
      day,
      tick,
      event_type: 'perception',
      content: perception,
      entities,
      location,
    });
    this.write({
      agent_id: agentId,
      day,
      tick,
      event_type: 'action',
      content: action,
      entities,
      location,
    });
    this.write({
      agent_id: agentId,
      day,
      tick,
      event_type: 'internal',
      content: outcome,
      entities,
      location,
    });
  }

  /** Get all buffer entries for an agent on a specific day, sorted by tick. */
  getDayEntries(agentId: string, day: number): EpisodeBufferEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id, agent_id, day, tick, event_type, content, entities, location
         FROM episode_buffer
         WHERE agent_id = ? AND day = ?
         ORDER BY tick ASC, id ASC`,
      )
      .all(agentId, day) as Array<{
      id: number;
      agent_id: string;
      day: number;
      tick: number;
      event_type: EpisodeBufferEntry['event_type'];
      content: string;
      entities: string;
      location: LocationId;
    }>;

    return rows.map((row) => ({
      id: row.id,
      agent_id: row.agent_id,
      day: row.day,
      tick: row.tick,
      event_type: row.event_type,
      content: row.content,
      entities: JSON.parse(row.entities) as string[],
      location: row.location,
    }));
  }

  /** Clear buffer entries for an agent+day (after consolidation). */
  clearDay(agentId: string, day: number): void {
    this.db
      .prepare(`DELETE FROM episode_buffer WHERE agent_id = ? AND day = ?`)
      .run(agentId, day);
  }
}
