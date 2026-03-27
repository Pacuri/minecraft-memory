import { AgentStatus, LocationId, TimeOfDay } from '../types';
import { WorldEngine } from '../world/engine';
import { LOCATIONS } from '../config';

export interface Perception {
  summary: string;
  full_text: string;
  present_agents: string[];
}

export function buildPerception(
  engine: WorldEngine,
  agent: AgentStatus,
  day: number,
  tick: number,
  allAgentNames: Map<string, string>,
): Perception {
  const loc = LOCATIONS[agent.location];
  const timeOfDay = WorldEngine.getTimeOfDay(tick);
  const isWinter = WorldEngine.isWinter(day);

  // 1. Location description
  const lines: string[] = [];
  lines.push(`You are at the ${loc.name}. ${loc.description}.`);

  // 2. Time of day and weather
  const weatherHint = isWinter
    ? 'The cold bites. Winter has come.'
    : day > 45
      ? 'The air grows cooler. Winter approaches.'
      : 'The weather is mild.';
  lines.push(`It is ${timeOfDay} on day ${day}. ${weatherHint}`);

  // 3. Available resources
  const resources = engine.getLocationResources(agent.location, day);
  const resourceParts: string[] = [];
  for (const [resource, quantity] of resources) {
    if (quantity > 0) {
      resourceParts.push(`${resource}: ${quantity}`);
    }
  }
  if (resourceParts.length > 0) {
    lines.push(`Resources here: ${resourceParts.join(', ')}`);
  } else {
    lines.push('No notable resources here.');
  }

  // 4. Other agents present
  const otherAgentIds = engine.getAgentsAtLocation(agent.location, day, tick, agent.agent_id);
  const presentNames: string[] = [];
  for (const id of otherAgentIds) {
    const name = allAgentNames.get(id) ?? id;
    presentNames.push(name);
  }

  if (presentNames.length === 1) {
    lines.push(`${presentNames[0]} is here.`);
  } else if (presentNames.length === 2) {
    lines.push(`${presentNames[0]} is here.`);
    lines.push(`${presentNames[1]} is here as well.`);
  } else if (presentNames.length > 2) {
    for (let i = 0; i < presentNames.length; i++) {
      if (i === 0) {
        lines.push(`${presentNames[i]} is here.`);
      } else {
        lines.push(`${presentNames[i]} is here as well.`);
      }
    }
  }

  // 5. Winter urgency
  if (isWinter && agent.location !== 'CAVE' && loc.shelter_capacity === 0) {
    lines.push('Without shelter tonight, you will suffer from the cold.');
  }

  const full_text = lines.join('\n');

  // Build summary
  const presentStr = presentNames.length > 0
    ? ` ${presentNames.join(' and ')} present.`
    : '';
  const resourceSummary = resourceParts.length > 0
    ? ` ${resourceParts[0]} available.`
    : '';
  const summary = `At ${agent.location}, ${timeOfDay}, day ${day}.${presentStr}${resourceSummary}`;

  return {
    summary,
    full_text,
    present_agents: otherAgentIds,
  };
}
