import {
  ActionType,
  AgentDecision,
  AgentStatus,
  LocationId,
  Inventory,
  WorldEvent,
} from '../types';
import { WorldEngine } from './engine';

export interface ActionResult {
  success: boolean;
  description: string;
  inventory_changes: Partial<Inventory>;
  health_change: number;
  morale_change: number;
  new_location?: LocationId;
  event: WorldEvent;
}

// Base yields for gathering actions
const BASE_FOOD_YIELD = 3;
const BASE_WOOD_YIELD = 3;
const BASE_STONE_YIELD = 2;
const BASE_FISH_YIELD = 4;
const FARM_HARVEST_BASE = 8;
const FARM_GROWTH_DAYS = 10;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampInventory(inv: Inventory): Inventory {
  return {
    food: Math.max(0, inv.food),
    water: Math.max(0, inv.water),
    wood: Math.max(0, inv.wood),
    stone: Math.max(0, inv.stone),
    tools: Math.max(0, inv.tools),
  };
}

function makeEvent(
  day: number,
  tick: number,
  agentId: string,
  location: LocationId,
  description: string,
  outcome: string | null,
  targetId: string | null = null,
  eventType: WorldEvent['event_type'] = 'action',
): WorldEvent {
  return {
    day,
    tick,
    event_type: eventType,
    agent_id: agentId,
    target_id: targetId,
    location,
    description,
    outcome,
  };
}

export function resolveAction(
  engine: WorldEngine,
  agent: AgentStatus,
  decision: AgentDecision,
  day: number,
  tick: number,
  agentSkills: { foraging: number; crafting: number; farming: number; fishing: number },
): ActionResult {
  const action = decision.action;
  const target = decision.target;
  const loc = agent.location;
  const inv = { ...agent.inventory };

  let result: ActionResult;

  switch (action) {
    case 'gather_food': {
      const yield_ = Math.max(1, Math.floor(BASE_FOOD_YIELD * agentSkills.foraging));
      inv.food += yield_;
      result = {
        success: true,
        description: `${agent.agent_id} gathered ${yield_} food at ${loc}`,
        inventory_changes: { food: yield_ },
        health_change: 0,
        morale_change: 0,
        event: makeEvent(day, tick, agent.agent_id, loc, `gather_food: gathered ${yield_} food`, 'success'),
      };
      break;
    }

    case 'gather_wood': {
      if (loc !== 'FOREST') {
        result = {
          success: false,
          description: `${agent.agent_id} tried to gather wood but is not at FOREST`,
          inventory_changes: {},
          health_change: 0,
          morale_change: 0,
          event: makeEvent(day, tick, agent.agent_id, loc, 'gather_wood: wrong location', 'failure'),
        };
        break;
      }
      const yield_ = Math.max(1, Math.floor(BASE_WOOD_YIELD * agentSkills.crafting));
      inv.wood += yield_;
      result = {
        success: true,
        description: `${agent.agent_id} gathered ${yield_} wood at FOREST`,
        inventory_changes: { wood: yield_ },
        health_change: 0,
        morale_change: 0,
        event: makeEvent(day, tick, agent.agent_id, loc, `gather_wood: gathered ${yield_} wood`, 'success'),
      };
      break;
    }

    case 'gather_stone': {
      if (loc !== 'CAVE' && loc !== 'HILLTOP') {
        result = {
          success: false,
          description: `${agent.agent_id} tried to gather stone but is not at CAVE or HILLTOP`,
          inventory_changes: {},
          health_change: 0,
          morale_change: 0,
          event: makeEvent(day, tick, agent.agent_id, loc, 'gather_stone: wrong location', 'failure'),
        };
        break;
      }
      const yield_ = Math.max(1, Math.floor(BASE_STONE_YIELD * agentSkills.crafting));
      inv.stone += yield_;
      result = {
        success: true,
        description: `${agent.agent_id} gathered ${yield_} stone at ${loc}`,
        inventory_changes: { stone: yield_ },
        health_change: 0,
        morale_change: 0,
        event: makeEvent(day, tick, agent.agent_id, loc, `gather_stone: gathered ${yield_} stone`, 'success'),
      };
      break;
    }

    case 'fish': {
      if (loc !== 'RIVER') {
        result = {
          success: false,
          description: `${agent.agent_id} tried to fish but is not at RIVER`,
          inventory_changes: {},
          health_change: 0,
          morale_change: 0,
          event: makeEvent(day, tick, agent.agent_id, loc, 'fish: wrong location', 'failure'),
        };
        break;
      }
      const yield_ = Math.max(1, Math.floor(BASE_FISH_YIELD * agentSkills.fishing));
      inv.food += yield_;
      result = {
        success: true,
        description: `${agent.agent_id} caught ${yield_} fish at RIVER`,
        inventory_changes: { food: yield_ },
        health_change: 0,
        morale_change: 0,
        event: makeEvent(day, tick, agent.agent_id, loc, `fish: caught ${yield_} food`, 'success'),
      };
      break;
    }

    case 'farm_plant': {
      if (loc !== 'FIELD') {
        result = {
          success: false,
          description: `${agent.agent_id} tried to plant but is not at FIELD`,
          inventory_changes: {},
          health_change: 0,
          morale_change: 0,
          event: makeEvent(day, tick, agent.agent_id, loc, 'farm_plant: wrong location', 'failure'),
        };
        break;
      }
      result = {
        success: true,
        description: `${agent.agent_id} planted crops at FIELD on day ${day}`,
        inventory_changes: {},
        health_change: 0,
        morale_change: 0,
        event: makeEvent(day, tick, agent.agent_id, loc, `farm_planted on day ${day}`, 'success'),
      };
      break;
    }

    case 'farm_harvest': {
      if (loc !== 'FIELD') {
        result = {
          success: false,
          description: `${agent.agent_id} tried to harvest but is not at FIELD`,
          inventory_changes: {},
          health_change: 0,
          morale_change: 0,
          event: makeEvent(day, tick, agent.agent_id, loc, 'farm_harvest: wrong location', 'failure'),
        };
        break;
      }
      // Check for a farm_planted event from 10+ days ago
      const plantedRows = engine['db']
        .prepare(
          `SELECT day FROM world_events
           WHERE location = 'FIELD'
             AND description LIKE 'farm_planted%'
             AND day <= ?
           ORDER BY day DESC
           LIMIT 1`,
        )
        .get(day - FARM_GROWTH_DAYS) as any;

      if (!plantedRows) {
        result = {
          success: false,
          description: `${agent.agent_id} tried to harvest but no crops are ready`,
          inventory_changes: {},
          health_change: 0,
          morale_change: 0,
          event: makeEvent(day, tick, agent.agent_id, loc, 'farm_harvest: no ready crops', 'failure'),
        };
        break;
      }
      const yield_ = Math.floor(FARM_HARVEST_BASE * agentSkills.farming);
      inv.food += yield_;
      result = {
        success: true,
        description: `${agent.agent_id} harvested ${yield_} food from FIELD`,
        inventory_changes: { food: yield_ },
        health_change: 0,
        morale_change: 0,
        event: makeEvent(day, tick, agent.agent_id, loc, `farm_harvest: harvested ${yield_} food`, 'success'),
      };
      break;
    }

    case 'build_shelter': {
      if (inv.wood < 5) {
        result = {
          success: false,
          description: `${agent.agent_id} tried to build shelter but lacks wood (need 5, have ${inv.wood})`,
          inventory_changes: {},
          health_change: 0,
          morale_change: 0,
          event: makeEvent(day, tick, agent.agent_id, loc, 'build_shelter: insufficient wood', 'failure'),
        };
        break;
      }
      const othersAtLocation = engine.getAgentsAtLocation(loc, day, tick, agent.agent_id);
      if (othersAtLocation.length === 0) {
        result = {
          success: false,
          description: `${agent.agent_id} tried to build shelter but no one else is here to help`,
          inventory_changes: {},
          health_change: 0,
          morale_change: 0,
          event: makeEvent(day, tick, agent.agent_id, loc, 'build_shelter: no helper present', 'failure'),
        };
        break;
      }
      inv.wood -= 5;
      result = {
        success: true,
        description: `${agent.agent_id} built a shelter at ${loc} with help from ${othersAtLocation[0]}`,
        inventory_changes: { wood: -5 },
        health_change: 0,
        morale_change: 2,
        event: makeEvent(
          day, tick, agent.agent_id, loc,
          `build_shelter: shelter built at ${loc}`,
          'success',
          othersAtLocation[0],
          'interaction',
        ),
      };
      break;
    }

    case 'craft_tool': {
      if (inv.stone < 2 || inv.wood < 1) {
        result = {
          success: false,
          description: `${agent.agent_id} tried to craft a tool but lacks materials (need 2 stone + 1 wood)`,
          inventory_changes: {},
          health_change: 0,
          morale_change: 0,
          event: makeEvent(day, tick, agent.agent_id, loc, 'craft_tool: insufficient materials', 'failure'),
        };
        break;
      }
      inv.stone -= 2;
      inv.wood -= 1;
      inv.tools += 1;
      result = {
        success: true,
        description: `${agent.agent_id} crafted a tool`,
        inventory_changes: { stone: -2, wood: -1, tools: 1 },
        health_change: 0,
        morale_change: 1,
        event: makeEvent(day, tick, agent.agent_id, loc, 'craft_tool: tool crafted', 'success'),
      };
      break;
    }

    case 'share': {
      if (!target) {
        result = {
          success: false,
          description: `${agent.agent_id} tried to share but no target specified`,
          inventory_changes: {},
          health_change: 0,
          morale_change: 0,
          event: makeEvent(day, tick, agent.agent_id, loc, 'share: no target', 'failure'),
        };
        break;
      }
      const othersHere = engine.getAgentsAtLocation(loc, day, tick, agent.agent_id);
      if (!othersHere.includes(target)) {
        result = {
          success: false,
          description: `${agent.agent_id} tried to share with ${target} but they are not here`,
          inventory_changes: {},
          health_change: 0,
          morale_change: 0,
          event: makeEvent(day, tick, agent.agent_id, loc, `share: target ${target} not at location`, 'failure', target, 'interaction'),
        };
        break;
      }
      const shareAmount = Math.min(2, inv.food);
      if (shareAmount <= 0) {
        result = {
          success: false,
          description: `${agent.agent_id} tried to share but has no food`,
          inventory_changes: {},
          health_change: 0,
          morale_change: 0,
          event: makeEvent(day, tick, agent.agent_id, loc, 'share: no food to share', 'failure', target, 'interaction'),
        };
        break;
      }
      inv.food -= shareAmount;
      // Update target's inventory
      const targetStatus = engine.getAgentStatus(target, day, tick);
      const targetInv = { ...targetStatus.inventory };
      targetInv.food += shareAmount;
      engine.saveAgentStatus({
        ...targetStatus,
        day,
        tick,
        inventory: clampInventory(targetInv),
      });
      result = {
        success: true,
        description: `${agent.agent_id} shared ${shareAmount} food with ${target}`,
        inventory_changes: { food: -shareAmount },
        health_change: 0,
        morale_change: 1,
        event: makeEvent(day, tick, agent.agent_id, loc, `share: gave ${shareAmount} food to ${target}`, 'success', target, 'interaction'),
      };
      break;
    }

    case 'steal': {
      if (!target) {
        result = {
          success: false,
          description: `${agent.agent_id} tried to steal but no target specified`,
          inventory_changes: {},
          health_change: 0,
          morale_change: 0,
          event: makeEvent(day, tick, agent.agent_id, loc, 'steal: no target', 'failure'),
        };
        break;
      }
      const stealOthers = engine.getAgentsAtLocation(loc, day, tick, agent.agent_id);
      if (!stealOthers.includes(target)) {
        result = {
          success: false,
          description: `${agent.agent_id} tried to steal from ${target} but they are not here`,
          inventory_changes: {},
          health_change: 0,
          morale_change: 0,
          event: makeEvent(day, tick, agent.agent_id, loc, `steal: target ${target} not at location`, 'failure', target, 'interaction'),
        };
        break;
      }
      const stealSuccess = Math.random() < 0.6;
      if (stealSuccess) {
        const victimStatus = engine.getAgentStatus(target, day, tick);
        const victimInv = { ...victimStatus.inventory };
        const stolen = Math.min(3, victimInv.food);
        victimInv.food -= stolen;
        inv.food += stolen;
        engine.saveAgentStatus({
          ...victimStatus,
          day,
          tick,
          inventory: clampInventory(victimInv),
        });
        result = {
          success: true,
          description: `${agent.agent_id} stole ${stolen} food from ${target}`,
          inventory_changes: { food: stolen },
          health_change: 0,
          morale_change: 0,
          event: makeEvent(day, tick, agent.agent_id, loc, `steal: took ${stolen} food from ${target}`, 'success', target, 'interaction'),
        };
      } else {
        result = {
          success: false,
          description: `${agent.agent_id} failed to steal from ${target} and was caught`,
          inventory_changes: {},
          health_change: 0,
          morale_change: -2,
          event: makeEvent(day, tick, agent.agent_id, loc, `steal: caught trying to steal from ${target}`, 'failure', target, 'interaction'),
        };
      }
      break;
    }

    case 'trade': {
      if (!target) {
        result = {
          success: false,
          description: `${agent.agent_id} tried to trade but no target specified`,
          inventory_changes: {},
          health_change: 0,
          morale_change: 0,
          event: makeEvent(day, tick, agent.agent_id, loc, 'trade: no target', 'failure'),
        };
        break;
      }
      const tradeOthers = engine.getAgentsAtLocation(loc, day, tick, agent.agent_id);
      if (!tradeOthers.includes(target)) {
        result = {
          success: false,
          description: `${agent.agent_id} tried to trade with ${target} but they are not here`,
          inventory_changes: {},
          health_change: 0,
          morale_change: 0,
          event: makeEvent(day, tick, agent.agent_id, loc, `trade: target ${target} not at location`, 'failure', target, 'interaction'),
        };
        break;
      }
      const tradePartner = engine.getAgentStatus(target, day, tick);
      const partnerInv = { ...tradePartner.inventory };

      // Determine trade direction: agent gives wood for food, or food for wood
      let tradeDesc: string;
      const invChanges: Partial<Inventory> = {};
      if (inv.wood >= 2 && partnerInv.food >= 2) {
        // Agent gives 2 wood, gets 2 food
        inv.wood -= 2;
        inv.food += 2;
        partnerInv.wood += 2;
        partnerInv.food -= 2;
        invChanges.wood = -2;
        invChanges.food = 2;
        tradeDesc = `traded 2 wood for 2 food with ${target}`;
      } else if (inv.food >= 2 && partnerInv.wood >= 2) {
        // Agent gives 2 food, gets 2 wood
        inv.food -= 2;
        inv.wood += 2;
        partnerInv.food += 2;
        partnerInv.wood -= 2;
        invChanges.food = -2;
        invChanges.wood = 2;
        tradeDesc = `traded 2 food for 2 wood with ${target}`;
      } else {
        result = {
          success: false,
          description: `${agent.agent_id} tried to trade with ${target} but neither has enough to trade`,
          inventory_changes: {},
          health_change: 0,
          morale_change: 0,
          event: makeEvent(day, tick, agent.agent_id, loc, `trade: insufficient resources for trade with ${target}`, 'failure', target, 'interaction'),
        };
        break;
      }
      engine.saveAgentStatus({
        ...tradePartner,
        day,
        tick,
        inventory: clampInventory(partnerInv),
      });
      result = {
        success: true,
        description: `${agent.agent_id} ${tradeDesc}`,
        inventory_changes: invChanges,
        health_change: 0,
        morale_change: 0,
        event: makeEvent(day, tick, agent.agent_id, loc, `trade: ${tradeDesc}`, 'success', target, 'interaction'),
      };
      break;
    }

    case 'talk': {
      const talkOthers = engine.getAgentsAtLocation(loc, day, tick, agent.agent_id);
      const hasSomeonePresent = talkOthers.length > 0;
      const moraleGain = hasSomeonePresent ? 0.5 : 0;
      const talkTarget = target || (hasSomeonePresent ? talkOthers[0] : null);
      const dialogue = decision.dialogue || '(silence)';
      result = {
        success: true,
        description: `${agent.agent_id} talked${talkTarget ? ` to ${talkTarget}` : ''}: "${dialogue}"`,
        inventory_changes: {},
        health_change: 0,
        morale_change: moraleGain,
        event: makeEvent(
          day, tick, agent.agent_id, loc,
          `talk: ${dialogue}`,
          hasSomeonePresent ? 'social' : 'soliloquy',
          talkTarget,
          'interaction',
        ),
      };
      break;
    }

    case 'move': {
      if (!target) {
        result = {
          success: false,
          description: `${agent.agent_id} tried to move but no destination specified`,
          inventory_changes: {},
          health_change: 0,
          morale_change: 0,
          event: makeEvent(day, tick, agent.agent_id, loc, 'move: no destination', 'failure'),
        };
        break;
      }
      const destination = target as LocationId;
      result = {
        success: true,
        description: `${agent.agent_id} moved from ${loc} to ${destination}`,
        inventory_changes: {},
        health_change: 0,
        morale_change: 0,
        new_location: destination,
        event: makeEvent(day, tick, agent.agent_id, destination, `move: ${loc} -> ${destination}`, 'success'),
      };
      break;
    }

    case 'rest': {
      result = {
        success: true,
        description: `${agent.agent_id} rested at ${loc}`,
        inventory_changes: {},
        health_change: 1,
        morale_change: 0.5,
        event: makeEvent(day, tick, agent.agent_id, loc, 'rest: resting', 'success'),
      };
      break;
    }

    default: {
      result = {
        success: false,
        description: `${agent.agent_id} attempted unknown action: ${action}`,
        inventory_changes: {},
        health_change: 0,
        morale_change: 0,
        event: makeEvent(day, tick, agent.agent_id, loc, `unknown action: ${action}`, 'failure'),
      };
    }
  }

  // Apply changes to agent status
  const finalHealth = clamp(agent.health + result.health_change, 0, 10);
  const finalMorale = clamp(agent.morale + result.morale_change, 0, 10);
  const finalLocation = result.new_location || agent.location;
  const finalInventory = clampInventory(inv);

  const updatedStatus: AgentStatus = {
    agent_id: agent.agent_id,
    day,
    tick,
    location: finalLocation,
    health: finalHealth,
    morale: finalMorale,
    inventory: finalInventory,
    alive: finalHealth > 0,
  };

  engine.saveAgentStatus(updatedStatus);
  engine.recordEvent(result.event);

  return result;
}
