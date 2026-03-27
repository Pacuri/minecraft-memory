import { initDatabase } from './memory/schema';
import { WorldEngine } from './world/engine';
import { resolveAction } from './world/actions';
import { AGENTS } from './config';
import { AgentDecision, ActionType, LocationId } from './types';

const ACTIONS: ActionType[] = [
  'gather_food', 'gather_wood', 'gather_stone', 'fish',
  'farm_plant', 'move', 'rest', 'talk',
];

function randomDecision(location: LocationId, agentIds: string[], selfId: string): AgentDecision {
  const others = agentIds.filter(id => id !== selfId);
  let action: ActionType;

  // Pick a location-appropriate action
  switch (location) {
    case 'RIVER': action = Math.random() < 0.7 ? 'fish' : 'rest'; break;
    case 'FOREST': action = Math.random() < 0.5 ? 'gather_food' : 'gather_wood'; break;
    case 'CAVE': action = Math.random() < 0.7 ? 'gather_stone' : 'rest'; break;
    case 'FIELD': action = Math.random() < 0.7 ? 'farm_plant' : 'rest'; break;
    case 'HILLTOP': action = Math.random() < 0.5 ? 'gather_stone' : 'rest'; break;
    default: action = 'rest';
  }

  // Occasionally move
  if (Math.random() < 0.15) {
    const locs: LocationId[] = ['RIVER', 'FOREST', 'CAVE', 'FIELD', 'HILLTOP'];
    action = 'move';
    return {
      action,
      target: locs[Math.floor(Math.random() * locs.length)],
      dialogue: null,
      internal_thought: 'wandering',
      emotional_state: { valence: 0, arousal: 0.3 },
    };
  }

  return {
    action,
    target: others.length > 0 ? others[0] : null,
    dialogue: null,
    internal_thought: 'doing my thing',
    emotional_state: { valence: 0, arousal: 0.3 },
  };
}

// Run smoke test
const dbPath = './data/smoke-test.db';
try { require('fs').unlinkSync(dbPath); } catch {}
require('fs').mkdirSync('./data', { recursive: true });

const db = initDatabase(dbPath);
const engine = new WorldEngine(db);
engine.initWorldState(AGENTS);

const agentIds = AGENTS.map(a => a.id);
const skillsMap = Object.fromEntries(AGENTS.map(a => [a.id, a.skills]));

console.log('=== Smoke Test: 10 days, random actions ===\n');

let deaths = 0;
for (let day = 1; day <= 10; day++) {
  engine.updateWorldResources(day);

  for (let tick = 0; tick < 4; tick++) {
    const time = WorldEngine.getTimeOfDay(tick);

    for (const agentId of agentIds) {
      const status = engine.getAgentStatus(agentId, day, tick);
      if (!status.alive) continue;

      const decision = randomDecision(status.location, agentIds, agentId);
      const result = resolveAction(engine, status, decision, day, tick, skillsMap[agentId]);

      if (day <= 2 || !result.success) {
        // Only log first 2 days and failures to keep output manageable
        if (day <= 2) {
          console.log(`  [Day ${day}, ${time}] ${result.description}`);
        }
      }
    }

    if (tick === 3) {
      engine.applyNightEffects(day);
    }
  }

  // Daily summary
  const statuses = agentIds.map(id => {
    try { return engine.getAgentStatus(id, day, 3); }
    catch { return null; }
  }).filter(Boolean);

  const alive = statuses.filter(s => s!.alive);
  const dead = statuses.filter(s => !s!.alive);
  if (dead.length > deaths) {
    console.log(`\n  *** Day ${day}: ${dead.length - deaths} agent(s) died ***`);
    deaths = dead.length;
  }

  if (day % 5 === 0 || day <= 2) {
    console.log(`\n--- Day ${day} Summary ---`);
    for (const s of statuses) {
      if (!s) continue;
      console.log(`  ${s.agent_id.padEnd(6)} | HP:${s.health.toFixed(0).padStart(3)} | Morale:${s.morale.toFixed(1).padStart(4)} | Loc:${s.location.padEnd(8)} | Food:${s.inventory.food} Water:${s.inventory.water} Wood:${s.inventory.wood} | ${s.alive ? 'alive' : 'DEAD'}`);
    }
  }
}

// Final stats
const events = db.prepare('SELECT COUNT(*) as count FROM world_events').get() as any;
const statuses = db.prepare('SELECT COUNT(*) as count FROM agent_status').get() as any;
console.log(`\n=== Final Stats ===`);
console.log(`  Events recorded: ${events.count}`);
console.log(`  Status snapshots: ${statuses.count}`);
console.log(`  Database size: ${(require('fs').statSync(dbPath).size / 1024).toFixed(1)} KB`);

db.close();
console.log('\nSmoke test passed!');
