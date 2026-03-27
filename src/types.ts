// ============================================================
// Shared types for the memory architecture stress test
// ============================================================

// --- World ---

export type LocationId = 'RIVER' | 'FOREST' | 'CAVE' | 'FIELD' | 'HILLTOP';
export type ResourceType = 'food' | 'water' | 'wood' | 'stone' | 'tools';
export type TimeOfDay = 'morning' | 'midday' | 'evening' | 'night';
export type EventType = 'action' | 'interaction' | 'environment' | 'death';

export interface Inventory {
  food: number;
  water: number;
  wood: number;
  stone: number;
  tools: number;
}

export interface AgentStatus {
  agent_id: string;
  day: number;
  tick: number;
  location: LocationId;
  health: number;
  morale: number;
  inventory: Inventory;
  alive: boolean;
}

export interface WorldResource {
  location: LocationId;
  resource: ResourceType;
  quantity: number;
}

export interface WorldEvent {
  id?: number;
  day: number;
  tick: number;
  event_type: EventType;
  agent_id: string | null;
  target_id: string | null;
  location: LocationId;
  description: string;
  outcome: string | null;
}

// --- Agent Actions ---

export type ActionType =
  | 'gather_food'
  | 'gather_water'
  | 'gather_wood'
  | 'gather_stone'
  | 'fish'
  | 'farm_plant'
  | 'farm_harvest'
  | 'build_shelter'
  | 'craft_tool'
  | 'share'
  | 'steal'
  | 'trade'
  | 'talk'
  | 'move'
  | 'rest';

export interface AgentDecision {
  action: ActionType;
  target: string | null;       // agent_id or LocationId
  dialogue: string | null;
  internal_thought: string;
  emotional_state: {
    valence: number;           // -1 to +1
    arousal: number;           // 0 to 1
  };
}

// --- Agent Config ---

export interface AgentSkills {
  foraging: number;
  crafting: number;
  farming: number;
  fishing: number;
}

export interface AgentConfig {
  id: string;
  name: string;
  personality_seed: string;
  starting_location: LocationId;
  skills: AgentSkills;
}

// --- Memory ---

export interface EpisodeBufferEntry {
  id?: number;
  agent_id: string;
  day: number;
  tick: number;
  event_type: 'perception' | 'action' | 'dialogue' | 'internal';
  content: string;
  entities: string[];
  location: LocationId;
}

export interface EpisodicMemory {
  id: string;
  agent_id: string;
  day: number;
  summary: string;
  entities: string[];
  location: LocationId;
  emotion_valence: number;
  emotion_arousal: number;
  importance: number;
  stm_strength: number;
  ltm_strength: number;
  retrieval_count: number;
  last_retrieved_day: number | null;
  tags: string[];
  causal_links: string[];
}

export interface SemanticMemory {
  id: string;
  agent_id: string;
  content: string;
  category: 'fact' | 'rule' | 'skill' | 'preference';
  confidence: number;
  source_episodes: string[];
  stm_strength: number;
  ltm_strength: number;
  retrieval_count: number;
  content_hash: string;
}

export interface Relationship {
  agent_id: string;
  target_id: string;
  trust: number;
  fear: number;
  respect: number;
  affection: number;
  rivalry: number;
  interaction_count: number;
  last_interaction_day: number | null;
  memory_notes: string;
}

export interface IdentityCore {
  agent_id: string;
  personality: string;
  principles: string[];
  narrative: string;
  core_bonds: Array<{ target: string; nature: string; strength: number }>;
  last_updated_day: number;
}

// --- Retrieval ---

export interface RetrievalQuery {
  agent_id: string;
  current_day: number;
  current_location: LocationId;
  present_agents: string[];
  current_situation: string;
  budget_tokens: number;
}

export interface ScoredMemory {
  id: string;
  table: 'episodic_memory' | 'semantic_memory';
  content: string;
  score: number;
  day?: number;
  emotion_arousal?: number;
  importance?: number;
}

// --- Simulation Config ---

export interface SimConfig {
  totalDays: number;
  agents: AgentConfig[];
  dbPath: string;
  verbose: boolean;
  noLlm: boolean;
}

// --- LLM ---

export interface LLMCallConfig {
  model: 'haiku' | 'sonnet';
  systemPrompt: string;
  userPrompt: string;
  timeoutMs?: number;
  maxTokens?: number;
}
