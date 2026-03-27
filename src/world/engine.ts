import Database from 'better-sqlite3';
import {
  LocationId,
  ResourceType,
  AgentConfig,
  AgentStatus,
  Inventory,
  WorldEvent,
  TimeOfDay,
} from '../types';

const INITIAL_RESOURCES: Record<LocationId, Partial<Record<ResourceType, number>>> = {
  RIVER: { food: 30, water: 999 },
  FOREST: { food: 50, wood: 40 },
  CAVE: { stone: 30 },
  FIELD: { food: 0 },
  HILLTOP: { stone: 10 },
};

const ALL_LOCATIONS: LocationId[] = ['RIVER', 'FOREST', 'CAVE', 'FIELD', 'HILLTOP'];
const ALL_RESOURCES: ResourceType[] = ['food', 'water', 'wood', 'stone', 'tools'];

const DEFAULT_INVENTORY: Inventory = { food: 2, water: 2, wood: 0, stone: 0, tools: 0 };

export class WorldEngine {
  private db: Database.Database;

  // Prepared statements (lazily cached)
  private stmts: {
    insertWorldState?: Database.Statement;
    insertAgentStatus?: Database.Statement;
    getAgentStatus?: Database.Statement;
    getAgentsAtLocation?: Database.Statement;
    getAgentsAtLocationExclude?: Database.Statement;
    getLocationResources?: Database.Statement;
    insertEvent?: Database.Statement;
    getLivingAgents?: Database.Statement;
    getLatestAgentStatus?: Database.Statement;
    getShelterEvent?: Database.Statement;
  } = {};

  constructor(db: Database.Database) {
    this.db = db;
  }

  private getStmt<K extends keyof typeof this.stmts>(
    key: K,
    sql: string,
  ): Database.Statement {
    if (!this.stmts[key]) {
      (this.stmts as any)[key] = this.db.prepare(sql);
    }
    return this.stmts[key] as Database.Statement;
  }

  initWorldState(agents: AgentConfig[]): void {
    const insertWs = this.getStmt(
      'insertWorldState',
      'INSERT OR REPLACE INTO world_state (day, tick, location, resource, quantity) VALUES (?, ?, ?, ?, ?)',
    );

    const insertAs = this.getStmt(
      'insertAgentStatus',
      'INSERT OR REPLACE INTO agent_status (agent_id, day, tick, location, health, morale, inventory, alive) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );

    const initTransaction = this.db.transaction(() => {
      // Insert initial resources for all locations
      for (const loc of ALL_LOCATIONS) {
        for (const res of ALL_RESOURCES) {
          const qty = INITIAL_RESOURCES[loc]?.[res] ?? 0;
          insertWs.run(1, 0, loc, res, qty);
        }
      }

      // Insert initial agent statuses
      for (const agent of agents) {
        insertAs.run(
          agent.id,
          1,
          0,
          agent.starting_location,
          10,
          5,
          JSON.stringify(DEFAULT_INVENTORY),
          1,
        );
      }
    });

    initTransaction();
  }

  updateWorldResources(day: number): void {
    const insertWs = this.getStmt(
      'insertWorldState',
      'INSERT OR REPLACE INTO world_state (day, tick, location, resource, quantity) VALUES (?, ?, ?, ?, ?)',
    );

    // Start with base values
    const resources: Record<LocationId, Record<ResourceType, number>> = {
      RIVER: { food: 30, water: 999, wood: 0, stone: 0, tools: 0 },
      FOREST: { food: 50, wood: 40, water: 0, stone: 0, tools: 0 },
      CAVE: { food: 0, water: 0, wood: 0, stone: 30, tools: 0 },
      FIELD: { food: 0, water: 0, wood: 0, stone: 0, tools: 0 },
      HILLTOP: { food: 0, water: 0, wood: 0, stone: 10, tools: 0 },
    };

    // After day 50: forest berries (food) set to 0
    if (day > 50) {
      resources.FOREST.food = 0;
    }

    // After day 60 (winter): river fish yield drops, forest wood drops
    if (day > 60) {
      resources.RIVER.food = Math.floor(resources.RIVER.food * 0.4);
      resources.FOREST.wood = Math.floor(resources.FOREST.wood * 0.5);
    }

    const updateTransaction = this.db.transaction(() => {
      for (const loc of ALL_LOCATIONS) {
        for (const res of ALL_RESOURCES) {
          insertWs.run(day, 0, loc, res, resources[loc][res]);
        }
      }
    });

    updateTransaction();
  }

  getAgentStatus(agentId: string, day: number, tick: number): AgentStatus {
    const stmt = this.getStmt(
      'getAgentStatus',
      `SELECT agent_id, day, tick, location, health, morale, inventory, alive
       FROM agent_status
       WHERE agent_id = ? AND day = ? AND tick = ?`,
    );

    const row = stmt.get(agentId, day, tick) as any;
    if (!row) {
      // Fall back to latest status for this agent up to the given day/tick
      const fallback = this.getStmt(
        'getLatestAgentStatus',
        `SELECT agent_id, day, tick, location, health, morale, inventory, alive
         FROM agent_status
         WHERE agent_id = ? AND (day < ? OR (day = ? AND tick <= ?))
         ORDER BY day DESC, tick DESC
         LIMIT 1`,
      );
      const fbRow = fallback.get(agentId, day, day, tick) as any;
      if (!fbRow) {
        throw new Error(`No status found for agent ${agentId} at or before day ${day}, tick ${tick}`);
      }
      return this.rowToAgentStatus(fbRow);
    }
    return this.rowToAgentStatus(row);
  }

  private rowToAgentStatus(row: any): AgentStatus {
    return {
      agent_id: row.agent_id,
      day: row.day,
      tick: row.tick,
      location: row.location as LocationId,
      health: row.health,
      morale: row.morale,
      inventory: JSON.parse(row.inventory) as Inventory,
      alive: row.alive === 1,
    };
  }

  saveAgentStatus(status: AgentStatus): void {
    const stmt = this.getStmt(
      'insertAgentStatus',
      'INSERT OR REPLACE INTO agent_status (agent_id, day, tick, location, health, morale, inventory, alive) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    stmt.run(
      status.agent_id,
      status.day,
      status.tick,
      status.location,
      status.health,
      status.morale,
      JSON.stringify(status.inventory),
      status.alive ? 1 : 0,
    );
  }

  getAgentsAtLocation(location: LocationId, day: number, tick: number, excludeId?: string): string[] {
    if (excludeId) {
      const stmt = this.getStmt(
        'getAgentsAtLocationExclude',
        `SELECT DISTINCT agent_id FROM agent_status
         WHERE location = ? AND day = ? AND tick = ? AND alive = 1 AND agent_id != ?`,
      );
      const rows = stmt.all(location, day, tick, excludeId) as any[];
      return rows.map((r) => r.agent_id);
    }

    const stmt = this.getStmt(
      'getAgentsAtLocation',
      `SELECT DISTINCT agent_id FROM agent_status
       WHERE location = ? AND day = ? AND tick = ? AND alive = 1`,
    );
    const rows = stmt.all(location, day, tick) as any[];
    return rows.map((r) => r.agent_id);
  }

  getLocationResources(location: LocationId, day: number): Map<ResourceType, number> {
    const stmt = this.getStmt(
      'getLocationResources',
      `SELECT resource, quantity FROM world_state
       WHERE location = ? AND day = ?
       ORDER BY tick DESC`,
    );
    const rows = stmt.all(location, day) as any[];
    const result = new Map<ResourceType, number>();
    // Use the first occurrence of each resource (highest tick)
    for (const row of rows) {
      if (!result.has(row.resource as ResourceType)) {
        result.set(row.resource as ResourceType, row.quantity);
      }
    }
    return result;
  }

  recordEvent(event: WorldEvent): void {
    const stmt = this.getStmt(
      'insertEvent',
      `INSERT INTO world_events (day, tick, event_type, agent_id, target_id, location, description, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      event.day,
      event.tick,
      event.event_type,
      event.agent_id,
      event.target_id,
      event.location,
      event.description,
      event.outcome,
    );
  }

  applyNightEffects(day: number): void {
    // Get all living agents from the most recent tick of this day
    const livingAgents = this.db
      .prepare(
        `SELECT DISTINCT a.agent_id
         FROM agent_status a
         WHERE a.alive = 1
           AND a.day = ?
         ORDER BY a.tick DESC`,
      )
      .all(day) as any[];

    // Deduplicate agent_ids (we want unique agents)
    const seen = new Set<string>();
    const uniqueAgentIds: string[] = [];
    for (const row of livingAgents) {
      if (!seen.has(row.agent_id)) {
        seen.add(row.agent_id);
        uniqueAgentIds.push(row.agent_id);
      }
    }

    // Check for shelter events
    const shelterStmt = this.db.prepare(
      `SELECT DISTINCT location FROM world_events
       WHERE description LIKE '%shelter%built%' OR description LIKE '%built%shelter%'
         OR description LIKE '%build_shelter%'`,
    );
    const shelterLocations = new Set(
      (shelterStmt.all() as any[]).map((r) => r.location as LocationId),
    );

    const nightTick = 3;

    for (const agentId of uniqueAgentIds) {
      // Get the latest status for this agent on this day
      const status = this.getAgentStatus(agentId, day, nightTick);
      if (!status.alive) continue;

      const inv = { ...status.inventory };
      let health = status.health;

      // Food consumption
      if (inv.food < 2) {
        health -= 1;
        inv.food = 0;
      } else {
        inv.food -= 2;
      }

      // Water consumption
      if (inv.water < 1) {
        health -= 2;
      } else {
        inv.water -= 1;
      }

      // Winter exposure check
      if (WorldEngine.isWinter(day) && status.location !== 'CAVE' && !shelterLocations.has(status.location)) {
        health -= 2;
      }

      // Clamp health
      health = Math.max(0, Math.min(10, health));

      const alive = health > 0;

      // If dead, record death event
      if (!alive) {
        this.recordEvent({
          day,
          tick: nightTick,
          event_type: 'death',
          agent_id: agentId,
          target_id: null,
          location: status.location,
          description: `${agentId} has died.`,
          outcome: `health reached 0`,
        });
      }

      // Save updated status for night tick
      this.saveAgentStatus({
        agent_id: agentId,
        day,
        tick: nightTick,
        location: status.location,
        health,
        morale: status.morale,
        inventory: inv,
        alive,
      });
    }
  }

  static getTimeOfDay(tick: number): TimeOfDay {
    switch (tick) {
      case 0:
        return 'morning';
      case 1:
        return 'midday';
      case 2:
        return 'evening';
      case 3:
        return 'night';
      default:
        return 'morning';
    }
  }

  static isWinter(day: number): boolean {
    return day >= 60;
  }
}
