import Database from 'better-sqlite3';

export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');

  db.exec(`
    -- WORLD STATE
    CREATE TABLE IF NOT EXISTS world_state (
      day INTEGER NOT NULL,
      tick INTEGER NOT NULL,
      location TEXT NOT NULL,
      resource TEXT NOT NULL,
      quantity REAL NOT NULL,
      PRIMARY KEY (day, tick, location, resource)
    );

    CREATE TABLE IF NOT EXISTS agent_status (
      agent_id TEXT NOT NULL,
      day INTEGER NOT NULL,
      tick INTEGER NOT NULL,
      location TEXT NOT NULL,
      health REAL NOT NULL DEFAULT 10,
      morale REAL NOT NULL DEFAULT 5,
      inventory TEXT NOT NULL DEFAULT '{}',
      alive INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (agent_id, day, tick)
    );

    CREATE TABLE IF NOT EXISTS world_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day INTEGER NOT NULL,
      tick INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      agent_id TEXT,
      target_id TEXT,
      location TEXT NOT NULL,
      description TEXT NOT NULL,
      outcome TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- AGENT MEMORY
    CREATE TABLE IF NOT EXISTS episode_buffer (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      day INTEGER NOT NULL,
      tick INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      content TEXT NOT NULL,
      entities TEXT DEFAULT '[]',
      location TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_epbuf_agent_day ON episode_buffer(agent_id, day);

    CREATE TABLE IF NOT EXISTS episodic_memory (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      day INTEGER NOT NULL,
      summary TEXT NOT NULL,
      entities TEXT DEFAULT '[]',
      location TEXT NOT NULL,
      emotion_valence REAL DEFAULT 0,
      emotion_arousal REAL DEFAULT 0.5,
      importance REAL DEFAULT 0.5,
      stm_strength REAL DEFAULT 1.0,
      ltm_strength REAL DEFAULT 0.3,
      retrieval_count INTEGER DEFAULT 0,
      last_retrieved_day INTEGER,
      tags TEXT DEFAULT '[]',
      causal_links TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_epmem_agent ON episodic_memory(agent_id);
    CREATE INDEX IF NOT EXISTS idx_epmem_strength ON episodic_memory(agent_id, stm_strength DESC);
    CREATE INDEX IF NOT EXISTS idx_epmem_entities ON episodic_memory(entities);

    CREATE TABLE IF NOT EXISTS semantic_memory (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT NOT NULL,
      confidence REAL DEFAULT 0.5,
      source_episodes TEXT DEFAULT '[]',
      stm_strength REAL DEFAULT 1.0,
      ltm_strength REAL DEFAULT 0.3,
      retrieval_count INTEGER DEFAULT 0,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_semantic_agent ON semantic_memory(agent_id);
    CREATE INDEX IF NOT EXISTS idx_semantic_hash ON semantic_memory(agent_id, content_hash);

    CREATE TABLE IF NOT EXISTS relationships (
      agent_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      trust REAL DEFAULT 0,
      fear REAL DEFAULT 0,
      respect REAL DEFAULT 0,
      affection REAL DEFAULT 0,
      rivalry REAL DEFAULT 0,
      interaction_count INTEGER DEFAULT 0,
      last_interaction_day INTEGER,
      memory_notes TEXT DEFAULT '',
      PRIMARY KEY (agent_id, target_id)
    );

    CREATE TABLE IF NOT EXISTS identity_core (
      agent_id TEXT PRIMARY KEY,
      personality TEXT NOT NULL,
      principles TEXT DEFAULT '[]',
      narrative TEXT DEFAULT '',
      core_bonds TEXT DEFAULT '[]',
      last_updated_day INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS consolidation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      day INTEGER NOT NULL,
      type TEXT NOT NULL,
      summary TEXT,
      stats TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return db;
}
