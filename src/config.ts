import type { AgentConfig, LocationId, ResourceType, SimConfig } from './types';

// --- Resource Rule ---

export interface ResourceRule {
  location: LocationId;
  resource: ResourceType;
  base_yield: number;
  winter_yield: number;
  seasonal_end?: number;
  infinite?: boolean;
}

// --- Agents ---

export const AGENTS: AgentConfig[] = [
  {
    id: 'kira',
    name: 'Kira',
    personality_seed: `Cautious and observant. Prefers to watch before acting. Values fairness but fears confrontation. Good at foraging. Will share resources if she feels safe, hoards if threatened.`,
    starting_location: 'FOREST',
    skills: { foraging: 0.8, crafting: 0.3, farming: 0.2, fishing: 0.4 },
  },
  {
    id: 'volen',
    name: 'Volen',
    personality_seed: `Bold and assertive. Natural leader type, but can be domineering. Prioritizes group survival but on his terms. Strong physically. Quick to anger but also quick to forgive.`,
    starting_location: 'CAVE',
    skills: { foraging: 0.4, crafting: 0.7, farming: 0.3, fishing: 0.6 },
  },
  {
    id: 'mira',
    name: 'Mira',
    personality_seed: `Warm and empathetic. Natural mediator. Skilled farmer. Puts others' needs before her own, sometimes to her detriment. Remembers kindness and holds grudges against cruelty.`,
    starting_location: 'FIELD',
    skills: { foraging: 0.5, crafting: 0.4, farming: 0.9, fishing: 0.3 },
  },
  {
    id: 'dax',
    name: 'Dax',
    personality_seed: `Pragmatic and calculating. Does what benefits him most. Will cooperate when advantageous, betray when profitable. Skilled at reading situations, poor at genuine connection.`,
    starting_location: 'RIVER',
    skills: { foraging: 0.6, crafting: 0.5, farming: 0.4, fishing: 0.8 },
  },
  {
    id: 'sera',
    name: 'Sera',
    personality_seed: `Quiet and self-reliant. Distrusts groups but craves belonging. Extremely resourceful alone. Opens up slowly over time. Once loyal, fiercely protective.`,
    starting_location: 'HILLTOP',
    skills: { foraging: 0.7, crafting: 0.6, farming: 0.5, fishing: 0.5 },
  },
];

// --- Locations ---

export const LOCATIONS: Record<LocationId, { name: string; description: string; shelter_capacity: number }> = {
  RIVER:   { name: 'River',   description: 'A wide river with fish and fresh water',    shelter_capacity: 0 },
  FOREST:  { name: 'Forest',  description: 'Dense woods with berries and timber',        shelter_capacity: 0 },
  CAVE:    { name: 'Cave',    description: 'A natural cave offering shelter and stone',   shelter_capacity: 3 },
  FIELD:   { name: 'Field',   description: 'Open farmland suitable for grain',            shelter_capacity: 0 },
  HILLTOP: { name: 'Hilltop', description: 'High ground with a view of all locations',    shelter_capacity: 0 },
};

// --- Resource Rules ---

export const RESOURCE_RULES: ResourceRule[] = [
  { location: 'RIVER',   resource: 'food',  base_yield: 3,  winter_yield: 1 },
  { location: 'RIVER',   resource: 'water', base_yield: 99, winter_yield: 99, infinite: true },
  { location: 'FOREST',  resource: 'food',  base_yield: 5,  winter_yield: 0,  seasonal_end: 50 },
  { location: 'FOREST',  resource: 'wood',  base_yield: 4,  winter_yield: 2 },
  { location: 'CAVE',    resource: 'stone', base_yield: 3,  winter_yield: 3 },
  { location: 'FIELD',   resource: 'food',  base_yield: 0,  winter_yield: 0 },
  { location: 'HILLTOP', resource: 'stone', base_yield: 1,  winter_yield: 1 },
];

// --- Default Simulation Config ---

export const DEFAULT_SIM_CONFIG: SimConfig = {
  totalDays: 100,
  agents: AGENTS,
  dbPath: './data/run-001.db',
  verbose: true,
  noLlm: false,
};
