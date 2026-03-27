import * as fs from 'fs';
import { initDatabase } from './memory/schema';
import { WorldEngine } from './world/engine';
import { resolveAction } from './world/actions';
import { LLMClient, tryParseJson } from './llm/client';
import { EpisodeBuffer } from './memory/buffer';
import { DecayEngine } from './memory/decay';
import { MemoryRetriever } from './memory/retrieve';
import { RelationshipManager } from './memory/relationships';
import { ConsolidationEngine } from './memory/consolidate';
import { IdentityManager } from './memory/identity';
import { buildPerception } from './agent/perceive';
import {
  buildAgentSystemPrompt,
  buildAgentUserPrompt,
  getAvailableActions,
} from './agent/prompts';
import { AGENTS, DEFAULT_SIM_CONFIG } from './config';
import {
  AgentConfig,
  AgentDecision,
  AgentStatus,
  ActionType,
  LocationId,
  SimConfig,
} from './types';

// ── CLI argument parsing ──

function parseArgs(): SimConfig {
  const args = process.argv.slice(2);
  const config = { ...DEFAULT_SIM_CONFIG };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--days': config.totalDays = parseInt(args[++i], 10); break;
      case '--agents': {
        const n = parseInt(args[++i], 10);
        config.agents = AGENTS.slice(0, n);
        break;
      }
      case '--db': config.dbPath = args[++i]; break;
      case '--no-llm': config.noLlm = true; break;
      case '--verbose': config.verbose = true; break;
      case '--quiet': config.verbose = false; break;
    }
  }
  return config;
}

// ── Random decision fallback (for --no-llm mode) ──

function randomDecision(
  agent: AgentStatus,
  presentAgents: string[],
): AgentDecision {
  const loc = agent.location;
  const inv = agent.inventory;

  // Survival priorities: water > food > other
  if (inv.water < 2 && loc !== 'RIVER') {
    return { action: 'move', target: 'RIVER', dialogue: null, internal_thought: 'need water', emotional_state: { valence: -0.3, arousal: 0.5 } };
  }
  if (loc === 'RIVER' && inv.water < 3) {
    return { action: 'gather_water', target: null, dialogue: null, internal_thought: 'need water', emotional_state: { valence: 0, arousal: 0.3 } };
  }
  if (loc === 'RIVER') {
    return { action: inv.food < 4 ? 'fish' : 'gather_water', target: null, dialogue: null, internal_thought: 'at the river', emotional_state: { valence: 0.1, arousal: 0.2 } };
  }

  const actions: ActionType[] = [];
  switch (loc) {
    case 'FOREST': actions.push('gather_food', 'gather_wood', 'gather_wood'); break;
    case 'CAVE': actions.push('gather_stone', 'craft_tool', 'rest'); break;
    case 'FIELD': actions.push('farm_plant', 'farm_harvest', 'rest'); break;
    case 'HILLTOP': actions.push('gather_stone', 'rest'); break;
    default: actions.push('rest');
  }

  // Move around occasionally
  if (Math.random() < 0.15) {
    const locs: LocationId[] = ['RIVER', 'FOREST', 'CAVE', 'FIELD', 'HILLTOP'];
    return { action: 'move', target: locs[Math.floor(Math.random() * locs.length)], dialogue: null, internal_thought: 'exploring', emotional_state: { valence: 0, arousal: 0.2 } };
  }

  if (presentAgents.length > 0 && Math.random() < 0.15) {
    const target = presentAgents[Math.floor(Math.random() * presentAgents.length)];
    return { action: Math.random() < 0.7 ? 'share' : 'talk', target, dialogue: 'Hey there.', internal_thought: 'being social', emotional_state: { valence: 0.2, arousal: 0.3 } };
  }

  const action = actions[Math.floor(Math.random() * actions.length)];
  return { action, target: null, dialogue: null, internal_thought: 'surviving', emotional_state: { valence: 0, arousal: 0.3 } };
}

// ── Shuffle utility ──

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Main simulation ──

async function runSimulation(config: SimConfig) {
  // Setup
  fs.mkdirSync('data', { recursive: true });
  const db = initDatabase(config.dbPath);
  const engine = new WorldEngine(db);
  const llm = config.noLlm ? null : new LLMClient();
  const buffer = new EpisodeBuffer(db);
  const decay = new DecayEngine(db);
  const retriever = new MemoryRetriever(db);
  const relationships = new RelationshipManager(db);
  const consolidation = llm
    ? new ConsolidationEngine(db, llm, buffer, decay, relationships)
    : null;
  const identity = llm ? new IdentityManager(db, llm) : null;

  // Initialize
  engine.initWorldState(config.agents);
  relationships.initRelationships(config.agents.map(a => a.id));
  for (const agent of config.agents) {
    identity?.initIdentity(agent.id, agent.personality_seed);
  }

  const agentMap = new Map(config.agents.map(a => [a.id, a]));
  const nameMap = new Map(config.agents.map(a => [a.id, a.name]));
  const skillsMap = new Map(config.agents.map(a => [a.id, a.skills]));
  const alive = new Set(config.agents.map(a => a.id));

  console.log(`\n=== Memory Architecture Stress Test ===`);
  console.log(`Days: ${config.totalDays} | Agents: ${config.agents.length} | LLM: ${!config.noLlm}`);
  console.log(`DB: ${config.dbPath}\n`);

  const simStart = Date.now();

  for (let day = 1; day <= config.totalDays; day++) {
    const dayStart = Date.now();
    engine.updateWorldResources(day);

    // ── 4 ticks per day ──
    for (let tick = 0; tick < 4; tick++) {
      const timeOfDay = WorldEngine.getTimeOfDay(tick);
      const livingAgents = shuffle([...alive]);

      // Group agents by location for parallelism info
      for (const agentId of livingAgents) {
        const status = engine.getAgentStatus(agentId, day, tick);
        if (!status.alive) { alive.delete(agentId); continue; }

        const agentCfg = agentMap.get(agentId)!;
        const presentAgents = engine.getAgentsAtLocation(
          status.location, day, tick, agentId,
        );

        let decision: AgentDecision;

        if (llm) {
          // ── LLM decision ──
          const perception = buildPerception(engine, status, day, tick, nameMap);
          const memories = retriever.retrieve({
            agent_id: agentId,
            current_day: day,
            current_location: status.location,
            present_agents: presentAgents,
            current_situation: perception.summary,
            budget_tokens: 2000,
          });
          const rels = relationships.getRelationshipsForTargets(agentId, presentAgents);
          const identityCore = identity?.getIdentity(agentId) ?? null;
          const availableActions = getAvailableActions(status.location).map(a => a.action);

          const systemPrompt = buildAgentSystemPrompt(identityCore, agentCfg.personality_seed);
          const userPrompt = buildAgentUserPrompt(
            status, day, tick, perception, memories, rels, availableActions,
          );

          try {
            decision = await llm.callJson<AgentDecision>({
              model: 'haiku',
              systemPrompt,
              userPrompt,
              maxTokens: 300,
            });

            // Validate action type
            const validActions: ActionType[] = [
              'gather_food', 'gather_water', 'gather_wood', 'gather_stone', 'fish',
              'farm_plant', 'farm_harvest', 'build_shelter', 'craft_tool',
              'share', 'steal', 'trade', 'talk', 'move', 'rest',
            ];
            if (!validActions.includes(decision.action)) {
              decision.action = 'rest';
            }
          } catch (err: any) {
            console.warn(`  [LLM FAIL] ${agentId}: ${err.message?.substring(0, 80)}`);
            decision = randomDecision(status, presentAgents);
          }
        } else {
          decision = randomDecision(status, presentAgents);
        }

        // ── Execute action ──
        const result = resolveAction(
          engine, status, decision, day, tick, skillsMap.get(agentId)!,
        );

        // ── Buffer experience ──
        const perception_text = `At ${status.location}, ${timeOfDay}. ${presentAgents.length > 0 ? `With: ${presentAgents.join(', ')}` : 'Alone.'}`;
        buffer.writeTickExperience(
          agentId, day, tick, status.location,
          perception_text,
          `${decision.action}${decision.target ? ` → ${decision.target}` : ''}: ${result.description}`,
          decision.internal_thought || '',
          presentAgents,
        );

        // ── Log ──
        if (config.verbose) {
          const thought = decision.internal_thought
            ? ` | thinking: "${decision.internal_thought.substring(0, 60)}"`
            : '';
          const dialogue = decision.dialogue
            ? ` | "${decision.dialogue.substring(0, 60)}"`
            : '';
          console.log(
            `[Day ${String(day).padStart(3)}, ${timeOfDay.padEnd(7)}] ` +
            `${agentId.padEnd(6)}(${status.location.padEnd(8)}): ` +
            `${result.description.substring(0, 60)}${dialogue}${thought}`,
          );
        }
      }

      // Night effects
      if (tick === 3) {
        engine.applyNightEffects(day);
        // Check for deaths
        for (const agentId of [...alive]) {
          const s = engine.getAgentStatus(agentId, day, 3);
          if (!s.alive) {
            alive.delete(agentId);
            console.log(`\n  *** ${nameMap.get(agentId)} has died on day ${day} ***\n`);
          }
        }
      }
    }

    // ── End of day: Consolidation ──
    if (consolidation) {
      const conResults = await Promise.all(
        [...alive].map(async agentId => {
          const r = await consolidation.consolidateDay(agentId, nameMap.get(agentId)!, day);
          return { agentId, ...r };
        }),
      );

      if (config.verbose) {
        console.log(`  [Day ${day} Consolidation]`);
        for (const r of conResults) {
          console.log(
            `    ${r.agentId}: ${r.episodes_created} episodes, ` +
            `${r.semantics_created} facts, ${r.relationships_updated} rels, ` +
            `archived: ${r.memories_archived.episodic}ep/${r.memories_archived.semantic}sem`,
          );
        }
      }
    } else {
      // No-LLM mode: just run decay
      for (const agentId of alive) {
        decay.applyDecay(agentId, day);
        buffer.clearDay(agentId, day);
      }
    }

    // ── Every 10 days: Identity consolidation ──
    if (day % 10 === 0 && identity) {
      console.log(`  [Day ${day} Identity Consolidation]`);
      for (const agentId of alive) {
        try {
          await identity.consolidateIdentity(agentId, nameMap.get(agentId)!, day);
          console.log(`    ${agentId}: identity updated`);
        } catch (err: any) {
          console.warn(`    ${agentId}: identity update failed: ${err.message?.substring(0, 80)}`);
        }
      }
    }

    // ── Day summary ──
    const dayMs = Date.now() - dayStart;
    if (day % 10 === 0 || day === 1 || alive.size === 0) {
      console.log(`\n--- Day ${day} Summary (${dayMs}ms) ---`);
      for (const agentId of config.agents.map(a => a.id)) {
        try {
          const s = engine.getAgentStatus(agentId, day, 3);
          const status = s.alive ? 'alive' : 'DEAD';
          console.log(
            `  ${(nameMap.get(agentId) || agentId).padEnd(6)} | ` +
            `HP:${s.health.toFixed(0).padStart(3)} Morale:${s.morale.toFixed(1).padStart(4)} | ` +
            `${s.location.padEnd(8)} | ` +
            `F:${s.inventory.food} W:${s.inventory.water} Wd:${s.inventory.wood} St:${s.inventory.stone} T:${s.inventory.tools} | ` +
            `${status}`,
          );
        } catch {}
      }
    }

    if (alive.size === 0) {
      console.log('\n  All agents have died. Simulation ended early.\n');
      break;
    }
  }

  // ── Final report ──
  const totalMs = Date.now() - simStart;
  const events = (db.prepare('SELECT COUNT(*) as c FROM world_events').get() as any).c;
  const episodes = (db.prepare('SELECT COUNT(*) as c FROM episodic_memory').get() as any).c;
  const semantics = (db.prepare('SELECT COUNT(*) as c FROM semantic_memory').get() as any).c;
  const bufferRemaining = (db.prepare('SELECT COUNT(*) as c FROM episode_buffer').get() as any).c;

  console.log(`\n${'='.repeat(60)}`);
  console.log('SIMULATION COMPLETE');
  console.log('='.repeat(60));
  console.log(`  Duration:        ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  Days completed:  ${Math.min(config.totalDays, config.totalDays)}`);
  console.log(`  Survivors:       ${alive.size}/${config.agents.length}`);
  console.log(`  World events:    ${events}`);
  console.log(`  Episodic memories: ${episodes}`);
  console.log(`  Semantic memories: ${semantics}`);
  console.log(`  Buffer remaining:  ${bufferRemaining}`);
  console.log(`  DB size:         ${(fs.statSync(config.dbPath).size / 1024).toFixed(1)} KB`);

  if (llm) {
    const stats = llm.getStats();
    console.log(`  LLM calls:       ${stats.calls}`);
    console.log(`  Tokens:          ${stats.inputTokens} in / ${stats.outputTokens} out`);
    console.log(`  Est. cost:       $${stats.estimatedCost.toFixed(2)}`);
  }

  db.close();
}

// ── Entry point ──
const config = parseArgs();
runSimulation(config).catch(err => {
  console.error('Simulation failed:', err);
  process.exit(1);
});
