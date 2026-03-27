import {
  AgentStatus,
  AgentDecision,
  IdentityCore,
  ScoredMemory,
  Relationship,
  ActionType,
  TimeOfDay,
} from '../types';
import { Perception } from './perceive';
import { WorldEngine } from '../world/engine';

// ---------------------------------------------------------------------------
// Agent decision system prompt
// ---------------------------------------------------------------------------

export function buildAgentSystemPrompt(
  identity: IdentityCore | null,
  personalitySeed: string,
): string {
  const name = identity?.agent_id ?? 'an unnamed survivor';
  const personality = identity?.personality ?? personalitySeed;

  return [
    `You are ${name}. ${personality}`,
    '',
    'IMPORTANT: Respond with a JSON object ONLY. No markdown, no explanation.',
    'The JSON must have: action, target, dialogue, internal_thought, emotional_state',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Agent decision user prompt
// ---------------------------------------------------------------------------

export function buildAgentUserPrompt(
  agent: AgentStatus,
  day: number,
  tick: number,
  perception: Perception,
  memories: ScoredMemory[],
  relationships: Relationship[],
  availableActions: ActionType[],
): string {
  const timeOfDay = WorldEngine.getTimeOfDay(tick);
  const inv = agent.inventory;
  const isWinter = WorldEngine.isWinter(day);

  const sections: string[] = [];

  // --- YOUR CURRENT STATE ---
  const stateLines = [
    '--- YOUR CURRENT STATE ---',
    `Day ${day}, ${timeOfDay}. You are at ${agent.location}.`,
    `Health: ${agent.health}/10 | Morale: ${agent.morale}/10`,
    `Inventory: food: ${inv.food}, water: ${inv.water}, wood: ${inv.wood}, stone: ${inv.stone}, tools: ${inv.tools}`,
  ];
  if (isWinter) {
    stateLines.push('Winter is here. Food is scarce and nights are deadly without shelter.');
  }
  sections.push(stateLines.join('\n'));

  // --- WHAT YOU SEE RIGHT NOW ---
  sections.push([
    '--- WHAT YOU SEE RIGHT NOW ---',
    perception.full_text,
  ].join('\n'));

  // --- MEMORIES THAT FEEL RELEVANT ---
  const memLines = ['--- MEMORIES THAT FEEL RELEVANT ---'];
  if (memories.length === 0) {
    memLines.push('(No strong memories come to mind.)');
  } else {
    for (const mem of memories) {
      const dayLabel = mem.day != null ? `Day ${mem.day}` : '?';
      memLines.push(`- [${dayLabel}] ${mem.content} (importance: ${mem.score.toFixed(1)})`);
    }
  }
  sections.push(memLines.join('\n'));

  // --- YOUR RELATIONSHIPS ---
  const relLines = ['--- YOUR RELATIONSHIPS ---'];
  const relevantRels = relationships.filter(
    (r) => perception.present_agents.includes(r.target_id) && r.interaction_count > 0,
  );
  if (relevantRels.length === 0) {
    relLines.push('(No one familiar nearby.)');
  } else {
    for (const rel of relevantRels) {
      const dims: string[] = [];
      if (rel.trust !== 0) dims.push(`trust: ${rel.trust.toFixed(1)}`);
      if (rel.fear !== 0) dims.push(`fear: ${rel.fear.toFixed(1)}`);
      if (rel.respect !== 0) dims.push(`respect: ${rel.respect.toFixed(1)}`);
      if (rel.affection !== 0) dims.push(`affection: ${rel.affection.toFixed(1)}`);
      if (rel.rivalry !== 0) dims.push(`rivalry: ${rel.rivalry.toFixed(1)}`);
      const dimStr = dims.length > 0 ? ` (${dims.join(', ')})` : '';
      const noteStr = rel.memory_notes ? ` -- ${rel.memory_notes}` : '';
      relLines.push(`- ${rel.target_id}${dimStr}${noteStr}`);
    }
  }
  sections.push(relLines.join('\n'));

  // --- AVAILABLE ACTIONS ---
  const actLines = ['--- AVAILABLE ACTIONS ---'];
  const actionDescs = getActionDescriptions();
  for (const action of availableActions) {
    const desc = actionDescs.get(action) ?? action;
    actLines.push(`- ${action}: ${desc}`);
  }
  sections.push(actLines.join('\n'));

  // Final instruction
  sections.push([
    'Decide your action. Think briefly about WHY, then choose.',
    'Respond as JSON: { "action": string, "target": string|null, "dialogue": string|null, "internal_thought": string, "emotional_state": { "valence": float, "arousal": float } }',
  ].join('\n'));

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Consolidation prompt (episode slicing)
// ---------------------------------------------------------------------------

export function buildConsolidationPrompt(
  agentName: string,
  dayEvents: string,
  recentMemories: string,
): string {
  const system = `You are the memory system for ${agentName}. Respond with a JSON array ONLY.`;
  const user = [
    `Here are the raw events from ${agentName}'s day:`,
    '',
    dayEvents,
    '',
    'Recent memories for context:',
    recentMemories || '(none)',
    '',
    'Slice these events into coherent episodes. For each episode, provide:',
    '- summary: a 1-2 sentence natural language summary',
    '- entities: array of agent/location names involved',
    '- emotion_valence: -1.0 to 1.0 (negative = bad, positive = good)',
    '- emotion_arousal: 0.0 to 1.0 (how intense)',
    '- importance: 1-10 (1 = trivial, 10 = life-changing)',
    '- tags: array of relevant tags (e.g. "cooperation", "theft", "hunger", "shelter")',
    '',
    'Return a JSON array of episode objects. No markdown, no explanation.',
  ].join('\n');

  return JSON.stringify({ system, user });
}

// ---------------------------------------------------------------------------
// Semantic extraction prompt
// ---------------------------------------------------------------------------

export function buildSemanticPrompt(
  agentName: string,
  dayEpisodes: string,
  existingSemantics: string,
): string {
  const system = `You are the knowledge extraction system for ${agentName}. Respond with a JSON array ONLY.`;
  const user = [
    `Recent episodes for ${agentName}:`,
    '',
    dayEpisodes,
    '',
    'Existing knowledge:',
    existingSemantics || '(none yet)',
    '',
    'Extract any NEW facts, rules, skills, or preferences that ${agentName} would learn from these episodes.',
    'Do not duplicate existing knowledge. Only extract genuinely new insights.',
    '',
    'For each item, provide:',
    '- content: the knowledge as a concise statement',
    '- category: "fact" | "rule" | "skill" | "preference"',
    '- confidence: 0.0 to 1.0',
    '- source_episode_summary: the episode summary this was derived from',
    '',
    'Return a JSON array. Empty array [] if nothing new. No markdown, no explanation.',
  ].join('\n');

  return JSON.stringify({ system, user });
}

// ---------------------------------------------------------------------------
// Relationship update prompt
// ---------------------------------------------------------------------------

export function buildRelationshipPrompt(
  agentName: string,
  targetName: string,
  episodes: string,
  currentRelationship: Relationship,
): string {
  const system = `You are the relationship tracking system for ${agentName}. Respond with a JSON object ONLY.`;
  const user = [
    `Recent interactions between ${agentName} and ${targetName}:`,
    '',
    episodes,
    '',
    'Current relationship state:',
    `  trust: ${currentRelationship.trust.toFixed(2)}`,
    `  fear: ${currentRelationship.fear.toFixed(2)}`,
    `  respect: ${currentRelationship.respect.toFixed(2)}`,
    `  affection: ${currentRelationship.affection.toFixed(2)}`,
    `  rivalry: ${currentRelationship.rivalry.toFixed(2)}`,
    `  interactions: ${currentRelationship.interaction_count}`,
    `  notes: ${currentRelationship.memory_notes || '(none)'}`,
    '',
    'Based on these interactions, how should the relationship change?',
    'Provide deltas between -0.3 and +0.3 for each dimension.',
    'Also update the memory_notes with a brief summary of how the relationship feels now.',
    '',
    'Return JSON: { "trust_delta": float, "fear_delta": float, "respect_delta": float, "affection_delta": float, "rivalry_delta": float, "memory_notes": string }',
    'No markdown, no explanation.',
  ].join('\n');

  return JSON.stringify({ system, user });
}

// ---------------------------------------------------------------------------
// Identity consolidation prompt (every ~10 days)
// ---------------------------------------------------------------------------

export function buildIdentityPrompt(
  agentName: string,
  currentIdentity: IdentityCore,
  strongMemories: string,
  relationshipDeltas: string,
): string {
  const system = `You are the identity evolution system for ${agentName}. Respond with a JSON object ONLY.`;
  const user = [
    `${agentName}'s current identity:`,
    `  Personality: ${currentIdentity.personality}`,
    `  Principles: ${currentIdentity.principles.join('; ')}`,
    `  Narrative: ${currentIdentity.narrative}`,
    '',
    'Strongest recent memories:',
    strongMemories || '(none)',
    '',
    'Relationship changes:',
    relationshipDeltas || '(none)',
    '',
    `Based on recent experiences, how has ${agentName} evolved?`,
    'Make small, organic changes. People do not transform overnight.',
    'Personality should drift subtly; principles may gain or lose emphasis; the narrative grows.',
    '',
    'Return JSON: { "personality": string, "principles": string[], "narrative": string }',
    'No markdown, no explanation.',
  ].join('\n');

  return JSON.stringify({ system, user });
}

// ---------------------------------------------------------------------------
// Available actions per location
// ---------------------------------------------------------------------------

const ACTION_DESCRIPTIONS: Record<ActionType, string> = {
  gather_food: 'Forage for berries, roots, or other food nearby',
  gather_wood: 'Collect wood for building or fuel',
  gather_stone: 'Mine or gather stone for construction',
  fish: 'Fish in the river for food',
  farm_plant: 'Plant crops in the field (will take days to grow)',
  farm_harvest: 'Harvest mature crops from the field',
  build_shelter: 'Build or improve shelter using wood and stone',
  craft_tool: 'Craft a tool from available materials',
  share: 'Give some of your resources to another agent',
  steal: 'Take resources from another agent without asking',
  trade: 'Propose a resource trade with another agent',
  talk: 'Speak to another agent nearby',
  move: 'Travel to a different location (target = location name)',
  rest: 'Rest to recover morale and a little health',
};

function getActionDescriptions(): Map<ActionType, string> {
  return new Map(Object.entries(ACTION_DESCRIPTIONS) as [ActionType, string][]);
}

const LOCATION_ACTIONS: Record<string, ActionType[]> = {
  RIVER: ['fish', 'gather_food', 'move', 'talk', 'share', 'trade', 'rest'],
  FOREST: ['gather_food', 'gather_wood', 'move', 'talk', 'share', 'trade', 'rest'],
  CAVE: ['gather_stone', 'craft_tool', 'move', 'talk', 'share', 'trade', 'rest'],
  FIELD: ['farm_plant', 'farm_harvest', 'gather_food', 'move', 'talk', 'share', 'trade', 'rest'],
  HILLTOP: ['gather_stone', 'move', 'talk', 'share', 'trade', 'rest'],
};

const ALWAYS_AVAILABLE: ActionType[] = ['steal', 'build_shelter'];

export function getAvailableActions(
  location: string,
): { action: ActionType; description: string }[] {
  const locationActions = LOCATION_ACTIONS[location] ?? ['move', 'rest'];
  const allActions = [...locationActions, ...ALWAYS_AVAILABLE];

  return allActions.map((action) => ({
    action,
    description: ACTION_DESCRIPTIONS[action],
  }));
}
