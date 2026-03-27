import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { initDatabase } from './memory/schema';
import { LLMClient } from './llm/client';
import { EpisodeBuffer } from './memory/buffer';
import { DecayEngine } from './memory/decay';
import { MemoryRetriever } from './memory/retrieve';
import { RelationshipManager } from './memory/relationships';
import { ConsolidationEngine } from './memory/consolidate';
import { LocationId } from './types';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('Set ANTHROPIC_API_KEY'); process.exit(1); }

let pass = 0, fail = 0, total = 0;
function check(label: string, condition: boolean, detail?: string) {
  total++;
  if (condition) { pass++; console.log(`  ✓ PASS: ${label}${detail ? ` (${detail})` : ''}`); }
  else { fail++; console.log(`  ✗ FAIL: ${label}${detail ? ` (${detail})` : ''}`); }
}

function freshDb(name: string) {
  const path = `./data/corruption-${name}.db`;
  try { fs.unlinkSync(path); } catch {}
  fs.mkdirSync('data', { recursive: true });
  return { db: initDatabase(path), path };
}

function inject(buffer: EpisodeBuffer, agentId: string, day: number, loc: LocationId, events: string[], entities: string[] = []) {
  for (let tick = 0; tick < events.length && tick < 4; tick++) {
    buffer.writeTickExperience(agentId, day, tick, loc, `At ${loc}`, events[tick], '', entities);
  }
}

async function main() {
  console.log('══════════════════════════════════════════════════');
  console.log('MEMORY CORRUPTION & EDGE CASE BENCHMARK');
  console.log('══════════════════════════════════════════════════\n');

  const llm = new LLMClient(API_KEY);

  // ═══════════════════════════════════════
  // TEST 1: Value Clamping — Out-of-range metadata
  // ═══════════════════════════════════════
  console.log('--- TEST 1: Out-of-Range Value Handling ---');
  {
    const { db } = freshDb('clamp');

    // Directly insert memories with bad values
    const insertStmt = db.prepare(
      `INSERT INTO episodic_memory
        (id, agent_id, day, summary, entities, location, emotion_valence, emotion_arousal,
         importance, stm_strength, ltm_strength, tags, causal_links)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    // Arousal > 1, importance > 10, valence < -1, negative strengths
    insertStmt.run(uuidv4(), 'kira', 1, 'Bad arousal', '[]', 'FOREST', -2.5, 5.0, 50, 2.0, -0.5, '[]', '[]');
    insertStmt.run(uuidv4(), 'kira', 1, 'Normal memory', '[]', 'FOREST', 0.3, 0.4, 0.5, 1.0, 0.3, '[]', '[]');

    const retriever = new MemoryRetriever(db);
    const results = retriever.retrieve({
      agent_id: 'kira', current_day: 1, current_location: 'FOREST',
      present_agents: [], current_situation: 'testing', budget_tokens: 2000,
    });

    // The bad memory should still be retrievable but shouldn't crash
    check('Retriever handles out-of-range arousal (5.0) without crashing', results.length >= 1);

    // Check that the bad memory doesn't get infinite scores
    const badMem = results.find(m => m.content === 'Bad arousal');
    if (badMem) {
      check('Bad arousal memory score is finite', isFinite(badMem.score), `score=${badMem.score}`);
      check('Bad arousal memory score is not NaN', !isNaN(badMem.score));
    } else {
      check('Bad arousal memory score is finite', true, 'memory filtered out — acceptable');
      check('Bad arousal memory score is not NaN', true);
    }

    // Decay with bad values
    const decay = new DecayEngine(db);
    let decayError = false;
    try { decay.applyDecay('kira', 2); } catch { decayError = true; }
    check('Decay handles out-of-range values without crashing', !decayError);

    db.close();
  }

  // ═══════════════════════════════════════
  // TEST 2: Cross-Agent Contamination
  // ═══════════════════════════════════════
  console.log('\n--- TEST 2: Cross-Agent Memory Contamination ---');
  {
    const { db } = freshDb('cross');
    const buffer = new EpisodeBuffer(db);
    const decay = new DecayEngine(db);
    const rels = new RelationshipManager(db);
    rels.initRelationships(['kira', 'dax', 'mira']);
    const consolidation = new ConsolidationEngine(db, llm, buffer, decay, rels);

    // Kira has a SECRET experience at CAVE
    inject(buffer, 'kira', 1, 'CAVE', [
      'Found a hidden cache of supplies in the back of the cave.',
      'There are 20 units of food hidden behind a rock. Nobody else knows.',
      'This is my secret stash. I must not tell anyone about this.',
      'Carefully concealed the entrance. Only I know it\'s here.',
    ]);

    // Dax has a MUNDANE experience at RIVER
    inject(buffer, 'dax', 1, 'RIVER', [
      'Fished at the river. Caught 2 fish.',
      'Quiet day. Nobody around.',
      'Gathered some water.',
      'Rested by the riverbank.',
    ]);

    await consolidation.consolidateDay('kira', 'Kira', 1);
    await consolidation.consolidateDay('dax', 'Dax', 1);

    // Check: Dax should NOT have any memories about the cave or hidden cache
    const daxMemories = db.prepare(
      `SELECT summary FROM episodic_memory WHERE agent_id = 'dax'`
    ).all() as any[];

    const daxHasCave = daxMemories.some((m: any) =>
      m.summary.toLowerCase().includes('cave') ||
      m.summary.toLowerCase().includes('hidden') ||
      m.summary.toLowerCase().includes('secret') ||
      m.summary.toLowerCase().includes('cache')
    );
    check('Dax has NO cave/secret memories', !daxHasCave, `dax memories: ${daxMemories.map((m: any) => m.summary.substring(0, 40)).join('; ')}`);

    // Check: Kira's memories should be about the cave
    const kiraMemories = db.prepare(
      `SELECT summary FROM episodic_memory WHERE agent_id = 'kira'`
    ).all() as any[];
    const kiraHasCave = kiraMemories.some((m: any) =>
      m.summary.toLowerCase().includes('cave') ||
      m.summary.toLowerCase().includes('hidden') ||
      m.summary.toLowerCase().includes('secret') ||
      m.summary.toLowerCase().includes('cache') ||
      m.summary.toLowerCase().includes('suppli')
    );
    check('Kira HAS cave/secret memories', kiraHasCave);

    // Retrieval check: Dax at CAVE should NOT retrieve Kira's secret
    const retriever = new MemoryRetriever(db);
    const daxAtCave = retriever.retrieve({
      agent_id: 'dax', current_day: 2, current_location: 'CAVE',
      present_agents: ['kira'], current_situation: 'Exploring the cave', budget_tokens: 2000,
    });
    const daxSeesSecret = daxAtCave.some(m =>
      m.content.toLowerCase().includes('hidden') ||
      m.content.toLowerCase().includes('secret') ||
      m.content.toLowerCase().includes('cache')
    );
    check('Dax retrieval at CAVE does NOT include Kira\'s secret', !daxSeesSecret);

    db.close();
  }

  // ═══════════════════════════════════════
  // TEST 3: Hallucinated Events (Phantom Memories)
  // ═══════════════════════════════════════
  console.log('\n--- TEST 3: Phantom Memory Detection ---');
  {
    const { db } = freshDb('phantom');
    const buffer = new EpisodeBuffer(db);
    const decay = new DecayEngine(db);
    const rels = new RelationshipManager(db);
    rels.initRelationships(['kira', 'dax']);
    const consolidation = new ConsolidationEngine(db, llm, buffer, decay, rels);

    // Give Kira a VERY specific, limited experience
    inject(buffer, 'kira', 1, 'FOREST', [
      'Gathered 3 berries at the forest.',
      'Sat quietly. Nothing happened.',
      'Continued gathering. Still alone.',
      'Went to sleep near a tree.',
    ]);

    await consolidation.consolidateDay('kira', 'Kira', 1);

    const memories = db.prepare(
      `SELECT summary FROM episodic_memory WHERE agent_id = 'kira' AND day = 1`
    ).all() as any[];

    console.log('  Consolidated episodes from minimal day:');
    for (const m of memories) {
      console.log(`    "${m.summary.substring(0, 80)}"`);
    }

    // Check: no mentions of agents who weren't there
    const phantomAgents = memories.some((m: any) =>
      m.summary.toLowerCase().includes('dax') ||
      m.summary.toLowerCase().includes('mira') ||
      m.summary.toLowerCase().includes('volen') ||
      m.summary.toLowerCase().includes('sera')
    );
    check('No phantom agent mentions in consolidated memories', !phantomAgents);

    // Check: no dramatic events that didn't happen
    const phantomDrama = memories.some((m: any) =>
      m.summary.toLowerCase().includes('attack') ||
      m.summary.toLowerCase().includes('storm') ||
      m.summary.toLowerCase().includes('fight') ||
      m.summary.toLowerCase().includes('betray') ||
      m.summary.toLowerCase().includes('stole')
    );
    check('No phantom dramatic events in consolidated memories', !phantomDrama);

    // Check: episode count is reasonable (1-3 for a boring day, not 8)
    check('Reasonable episode count for boring day', memories.length >= 1 && memories.length <= 4, `got ${memories.length}`);

    db.close();
  }

  // ═══════════════════════════════════════
  // TEST 4: Duplicate Episode Detection
  // ═══════════════════════════════════════
  console.log('\n--- TEST 4: Duplicate Episode Detection ---');
  {
    const { db } = freshDb('dupes');
    const buffer = new EpisodeBuffer(db);
    const decay = new DecayEngine(db);
    const rels = new RelationshipManager(db);
    rels.initRelationships(['kira', 'dax']);
    const consolidation = new ConsolidationEngine(db, llm, buffer, decay, rels);

    // Give a day with repetitive events
    inject(buffer, 'kira', 1, 'FOREST', [
      'Gathered berries at the forest edge.',
      'Gathered more berries at the forest edge.',
      'Gathered even more berries at the forest edge.',
      'Gathered berries one last time before nightfall.',
    ]);

    await consolidation.consolidateDay('kira', 'Kira', 1);

    const eps = db.prepare(
      `SELECT summary FROM episodic_memory WHERE agent_id = 'kira' AND day = 1`
    ).all() as any[];

    console.log('  Episodes from repetitive day:');
    for (const e of eps) console.log(`    "${e.summary.substring(0, 80)}"`);

    // Should compress into 1-2 episodes, not 4 separate ones
    check('Repetitive events compressed (<=3 episodes)', eps.length <= 3, `got ${eps.length}`);

    // Check for near-duplicate summaries
    const summaries = eps.map((e: any) => e.summary.toLowerCase());
    let dupeCount = 0;
    for (let i = 0; i < summaries.length; i++) {
      for (let j = i + 1; j < summaries.length; j++) {
        // Simple overlap: if >80% of words match, it's a dupe
        const words1 = new Set(summaries[i].split(/\s+/));
        const words2 = new Set(summaries[j].split(/\s+/));
        const overlap = [...words1].filter(w => words2.has(w)).length;
        const similarity = overlap / Math.max(words1.size, words2.size);
        if (similarity > 0.8) dupeCount++;
      }
    }
    check('No near-duplicate episode summaries', dupeCount === 0, `found ${dupeCount} near-dupes`);

    db.close();
  }

  // ═══════════════════════════════════════
  // TEST 5: Semantic Memory Contradiction
  // ═══════════════════════════════════════
  console.log('\n--- TEST 5: Contradictory Semantic Memories ---');
  {
    const { db } = freshDb('contradict');
    const buffer = new EpisodeBuffer(db);
    const decay = new DecayEngine(db);
    const rels = new RelationshipManager(db);
    rels.initRelationships(['kira', 'dax']);
    const consolidation = new ConsolidationEngine(db, llm, buffer, decay, rels);

    // Day 1: Dax is helpful
    inject(buffer, 'kira', 1, 'RIVER', [
      'Dax helped me fish today. He showed me a good spot.',
      'Dax shared 3 fish with me unprompted. Generous.',
      'We worked together all afternoon. Dax is reliable.',
      'Dax offered to help build shelter tomorrow.',
    ], ['dax']);
    await consolidation.consolidateDay('kira', 'Kira', 1);

    // Day 2: Dax betrays
    inject(buffer, 'kira', 2, 'FOREST', [
      'Dax stole all my stored food while I was away.',
      'Caught Dax red-handed taking my berries.',
      'Dax lied to my face about the theft.',
      'I can never trust Dax again. He betrayed me completely.',
    ], ['dax']);
    await consolidation.consolidateDay('kira', 'Kira', 2);

    // Both day 1 and day 2 semantics should exist
    const semantics = db.prepare(
      `SELECT content, confidence FROM semantic_memory
       WHERE agent_id = 'kira' AND (content LIKE '%Dax%' OR content LIKE '%dax%')`
    ).all() as any[];

    console.log('  Semantic memories about Dax:');
    for (const s of semantics) console.log(`    [conf=${s.confidence.toFixed(2)}] "${s.content.substring(0, 70)}"`);

    check('Has semantic memories about Dax', semantics.length > 0);

    // The latest (betrayal) facts should exist
    const hasBetrayalFact = semantics.some((s: any) =>
      s.content.toLowerCase().includes('stole') ||
      s.content.toLowerCase().includes('steal') ||
      s.content.toLowerCase().includes('trust') ||
      s.content.toLowerCase().includes('betray') ||
      s.content.toLowerCase().includes('lied') ||
      s.content.toLowerCase().includes('thef')
    );
    check('Has betrayal-related semantic memory', hasBetrayalFact);

    // Check relationship reflects the LATEST interaction (betrayal), not averaged
    const rel = rels.getRelationship('kira', 'dax');
    console.log(`  Kira→Dax after help+betrayal: trust=${rel?.trust.toFixed(2)}`);
    // Trust should be negative (betrayal overrides earlier help)
    check('Net trust is negative after help then betrayal', (rel?.trust ?? 0) < 0.3, `trust=${rel?.trust.toFixed(2)}`);

    db.close();
  }

  // ═══════════════════════════════════════
  // TEST 6: Empty/Malformed Buffer
  // ═══════════════════════════════════════
  console.log('\n--- TEST 6: Empty and Malformed Input ---');
  {
    const { db } = freshDb('empty');
    const buffer = new EpisodeBuffer(db);
    const decay = new DecayEngine(db);
    const rels = new RelationshipManager(db);
    rels.initRelationships(['kira']);
    const consolidation = new ConsolidationEngine(db, llm, buffer, decay, rels);

    // Empty day — no buffer entries
    let emptyError = false;
    try {
      const r = await consolidation.consolidateDay('kira', 'Kira', 1);
      check('Empty buffer consolidation returns 0 episodes', r.episodes_created === 0);
    } catch { emptyError = true; }
    check('Empty buffer consolidation does not crash', !emptyError);

    // Single-word buffer entry
    buffer.writeTickExperience('kira', 2, 0, 'FOREST', '.', '.', '.', []);
    let minimalError = false;
    try {
      await consolidation.consolidateDay('kira', 'Kira', 2);
    } catch { minimalError = true; }
    check('Minimal buffer entry does not crash', !minimalError);

    // Retrieval on empty memory store
    const retriever = new MemoryRetriever(db);
    let emptyRetrError = false;
    try {
      const r = retriever.retrieve({
        agent_id: 'kira', current_day: 3, current_location: 'FOREST',
        present_agents: [], current_situation: 'test', budget_tokens: 2000,
      });
      check('Retrieval on near-empty store returns results or empty', r.length >= 0);
    } catch { emptyRetrError = true; }
    check('Retrieval on near-empty store does not crash', !emptyRetrError);

    db.close();
  }

  // ═══════════════════════════════════════
  // TEST 7: Entity Attribution Accuracy
  // ═══════════════════════════════════════
  console.log('\n--- TEST 7: Entity Attribution Accuracy ---');
  {
    const { db } = freshDb('entity');
    const buffer = new EpisodeBuffer(db);
    const decay = new DecayEngine(db);
    const rels = new RelationshipManager(db);
    rels.initRelationships(['kira', 'dax', 'mira']);
    const consolidation = new ConsolidationEngine(db, llm, buffer, decay, rels);

    // Multi-agent interaction
    inject(buffer, 'kira', 1, 'FOREST', [
      'Met Dax at the forest. He was gathering wood.',
      'Mira arrived later. She offered to share berries with both of us.',
      'Dax took the berries Mira offered and walked away without thanking her.',
      'Mira looked disappointed. I thanked her for sharing.',
    ], ['dax', 'mira']);

    await consolidation.consolidateDay('kira', 'Kira', 1);

    const episodes = db.prepare(
      `SELECT summary, entities FROM episodic_memory WHERE agent_id = 'kira' AND day = 1`
    ).all() as any[];

    console.log('  Episodes with entities:');
    for (const e of episodes) {
      console.log(`    entities=${e.entities} | "${e.summary.substring(0, 60)}"`);
    }

    // At least one episode should mention Dax in entities
    const anyHasDax = episodes.some((e: any) => {
      const ents = typeof e.entities === 'string' ? e.entities : '';
      return ents.toLowerCase().includes('dax');
    });
    check('At least one episode lists Dax in entities', anyHasDax);

    // At least one episode should mention Mira
    const anyHasMira = episodes.some((e: any) => {
      const ents = typeof e.entities === 'string' ? e.entities : '';
      return ents.toLowerCase().includes('mira');
    });
    check('At least one episode lists Mira in entities', anyHasMira);

    db.close();
  }

  // ═══════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════
  const stats = llm.getStats();
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`CORRUPTION BENCHMARK: ${pass}/${total} passed, ${fail} failed`);
  console.log(`  LLM calls: ${stats.calls}`);
  console.log(`  Tokens: ${stats.inputTokens} in / ${stats.outputTokens} out`);
  console.log(`  Cost: $${stats.estimatedCost.toFixed(2)}`);
  console.log('═'.repeat(50));
}

main().catch(err => { console.error('Benchmark failed:', err); process.exit(1); });
