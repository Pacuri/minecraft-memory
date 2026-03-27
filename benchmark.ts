import { ProxyAgent, setGlobalDispatcher } from "undici";
import Anthropic from "@anthropic-ai/sdk";

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("Set ANTHROPIC_API_KEY env var");
  process.exit(1);
}
const MODEL = "claude-haiku-4-5-20251001";

// Proxy support
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

const client = new Anthropic({ apiKey: API_KEY });

interface CallResult {
  ms: number;
  inputTokens: number;
  outputTokens: number;
  text: string;
  success: boolean;
}

interface BenchmarkResult {
  test: string;
  calls: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  failures: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  totalMs: number;
}

async function timedCall(
  system: string,
  user: string,
  maxTokens: number
): Promise<CallResult> {
  const start = performance.now();
  try {
    const r = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    });
    const ms = performance.now() - start;
    const text = r.content[0].type === "text" ? r.content[0].text : "";
    return {
      ms,
      inputTokens: r.usage.input_tokens,
      outputTokens: r.usage.output_tokens,
      text,
      success: true,
    };
  } catch (err: any) {
    const ms = performance.now() - start;
    console.error(`  FAILED (${ms.toFixed(0)}ms): ${err.message}`);
    return { ms, inputTokens: 0, outputTokens: 0, text: "", success: false };
  }
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function summarize(test: string, results: CallResult[]): BenchmarkResult {
  const ok = results.filter((r) => r.success);
  const times = ok.map((r) => r.ms).sort((a, b) => a - b);
  const totalMs = times.reduce((a, b) => a + b, 0);
  return {
    test,
    calls: results.length,
    avgMs: times.length ? totalMs / times.length : 0,
    minMs: times[0] ?? 0,
    maxMs: times[times.length - 1] ?? 0,
    p50Ms: times.length ? percentile(times, 50) : 0,
    p95Ms: times.length ? percentile(times, 95) : 0,
    failures: results.length - ok.length,
    avgInputTokens: ok.length
      ? ok.reduce((a, r) => a + r.inputTokens, 0) / ok.length
      : 0,
    avgOutputTokens: ok.length
      ? ok.reduce((a, r) => a + r.outputTokens, 0) / ok.length
      : 0,
    totalMs,
  };
}

function tryParseJson(text: string): any | null {
  let s = text.trim();
  // Strip markdown code blocks
  const cb = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (cb) s = cb[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    // Try extracting first JSON object/array
    const m = s.match(/[\[{][\s\S]*[\]}]/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {}
    }
    return null;
  }
}

// ═══════════════════════════════════════════════
// TEST 1: Minimal serial (cold start + warm)
// ═══════════════════════════════════════════════
async function test1_minimal(): Promise<BenchmarkResult> {
  console.log("\n=== Test 1: Minimal call (serial, 5x) ===");
  const results: CallResult[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await timedCall(
      "Reply with exactly the JSON given.",
      '{"status":"ok"}',
      16
    );
    console.log(
      `  #${i + 1}: ${r.ms.toFixed(0)}ms | ${r.inputTokens}in/${r.outputTokens}out | ${r.text.substring(0, 40)}`
    );
    results.push(r);
  }
  return summarize("1-minimal-serial", results);
}

// ═══════════════════════════════════════════════
// TEST 2: Realistic agent decision (serial)
// ═══════════════════════════════════════════════
async function test2_agentDecision(): Promise<BenchmarkResult> {
  console.log("\n=== Test 2: Agent decision (serial, 5x) ===");
  const system = `You are Kira. Cautious and observant. Prefers to watch before acting. Values fairness but fears confrontation. Good at foraging. Will share resources if she feels safe, hoards if threatened.

IMPORTANT: Respond with a JSON object ONLY, no other text.`;

  const user = `--- YOUR CURRENT STATE ---
Day 8, Evening. You are at FOREST.
Health: 8/10 | Morale: 4/10
Inventory: { food: 2, water: 1, wood: 0, stone: 0, tools: 0 }

--- WHAT YOU SEE RIGHT NOW ---
The forest is quiet. Berries are plentiful on the bushes near the stream.
Dax is here, gathering wood near the tree line. He hasn't noticed you yet.
You notice your food stockpile is smaller than you left it this morning.

--- MEMORIES THAT FEEL RELEVANT ---
- [Day 5] Dax was asking about where I store my food. He seemed very interested. (importance: 0.6)
- [Day 7] I gathered 5 berries and stored them by the old oak. (importance: 0.3)
- [Day 3] Mira shared water with me when I was thirsty. (importance: 0.5)

--- YOUR RELATIONSHIPS ---
Dax: trust: -0.1, respect: 0.2 | "Pragmatic, hard to read."

--- AVAILABLE ACTIONS ---
gather_berries, gather_wood, fish, move(location), talk(agent), share(resource,agent), rest, craft

Respond as JSON: { "action": string, "target": string|null, "dialogue": string|null, "internal_thought": string, "emotional_state": { "valence": float, "arousal": float } }`;

  const results: CallResult[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await timedCall(system, user, 300);
    const parsed = tryParseJson(r.text);
    console.log(
      `  #${i + 1}: ${r.ms.toFixed(0)}ms | ${r.inputTokens}in/${r.outputTokens}out | parsed: ${parsed ? "YES" : "NO"} | action: ${parsed?.action ?? "?"}`
    );
    if (parsed?.internal_thought)
      console.log(
        `    thought: "${parsed.internal_thought.substring(0, 100)}"`
      );
    results.push(r);
  }
  return summarize("2-agent-decision", results);
}

// ═══════════════════════════════════════════════
// TEST 3: 5 parallel calls (simulating one tick)
// ═══════════════════════════════════════════════
async function test3_parallelTick(): Promise<BenchmarkResult> {
  console.log("\n=== Test 3: Parallel tick (5 concurrent x 3 batches) ===");
  const agents = ["Kira", "Volen", "Mira", "Dax", "Sera"];
  const all: CallResult[] = [];

  for (let b = 0; b < 3; b++) {
    const wallStart = performance.now();
    const batch = await Promise.all(
      agents.map((name) =>
        timedCall(
          `You are ${name}. Respond with JSON only.`,
          `Day ${10 + b}, Morning. Alone at your location. Health: 8/10. Food: 3.
JSON: { "action": string, "internal_thought": string }`,
          128
        )
      )
    );
    const wallMs = performance.now() - wallStart;
    const fails = batch.filter((r) => !r.success).length;
    console.log(
      `  Batch ${b + 1}: ${wallMs.toFixed(0)}ms wall | individual: [${batch.map((r) => r.ms.toFixed(0)).join(", ")}] | fails: ${fails}`
    );
    all.push(...batch);
  }
  return summarize("3-parallel-5x3", all);
}

// ═══════════════════════════════════════════════
// TEST 4: Consolidation (larger output)
// ═══════════════════════════════════════════════
async function test4_consolidation(): Promise<BenchmarkResult> {
  console.log("\n=== Test 4: Consolidation (serial, 3x) ===");
  const system = `You are the memory system for Kira. Respond with a JSON array ONLY.`;
  const user = `Slice today into episodes. Each: { "summary": string, "entities": string[], "emotion_valence": float, "emotion_arousal": float, "importance": float, "tags": string[] }

RAW EVENTS:
[Morning] Kira woke at FOREST. Gathered 3 berries. Saw deer tracks.
[Morning] Volen arrived. Asked Kira to help build shelter. She said she'd think about it.
[Midday] Moved to RIVER. Caught 2 fish. Dax was there fishing silently.
[Midday] Noticed stored food was less than yesterday. Remembers Dax asking about her food.
[Evening] Returned to FOREST. Confronted Dax. He denied stealing. She didn't believe him.
[Evening] Mira offered grain. Kira accepted gratefully.
[Night] Slept at FOREST edge. Cold but manageable. Kept food close.`;

  const results: CallResult[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await timedCall(system, user, 1024);
    const parsed = tryParseJson(r.text);
    console.log(
      `  #${i + 1}: ${r.ms.toFixed(0)}ms | ${r.inputTokens}in/${r.outputTokens}out | episodes: ${Array.isArray(parsed) ? parsed.length : "PARSE_FAIL"}`
    );
    results.push(r);
  }
  return summarize("4-consolidation", results);
}

// ═══════════════════════════════════════════════
// TEST 5: Sustained throughput (full simulated day)
// ═══════════════════════════════════════════════
async function test5_sustained(): Promise<BenchmarkResult> {
  console.log("\n=== Test 5: Full day simulation (4 ticks x 5 agents) ===");
  const all: CallResult[] = [];
  const dayStart = performance.now();

  for (let tick = 0; tick < 4; tick++) {
    const time = ["Morning", "Midday", "Evening", "Night"][tick];
    const tickStart = performance.now();
    const batch = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        timedCall(
          `You are Agent${i}. Respond JSON only.`,
          `Day 1, ${time}. Health: ${(7 + Math.random() * 3).toFixed(1)}/10. Food: ${Math.floor(Math.random() * 5)}.
JSON: { "action": string, "internal_thought": string }`,
          128
        )
      )
    );
    const tickMs = performance.now() - tickStart;
    console.log(
      `  ${time.padEnd(8)}: ${tickMs.toFixed(0)}ms wall | fails: ${batch.filter((r) => !r.success).length}`
    );
    all.push(...batch);
  }

  const dayMs = performance.now() - dayStart;
  console.log(`  Full day wall-clock: ${dayMs.toFixed(0)}ms`);
  return summarize("5-sustained-day", all);
}

// ═══════════════════════════════════════════════
// TEST 6: JSON reliability (15 varied calls)
// ═══════════════════════════════════════════════
async function test6_jsonReliability(): Promise<BenchmarkResult> {
  console.log("\n=== Test 6: JSON parse reliability (15 calls) ===");
  let parseOk = 0;
  const results: CallResult[] = [];

  const prompts = [
    { s: "Agent. JSON only.", u: 'Action. JSON: {"action":"gather","thought":"reason"}' },
    { s: "Memory system. JSON array only.", u: 'Episodes: [{"summary":"test","importance":0.5}]' },
    {
      s: "Relationship analyzer. JSON only.",
      u: 'Deltas: {"trust_delta":0.1,"fear_delta":0,"notes":"brief note"}',
    },
  ];

  for (let i = 0; i < 15; i++) {
    const p = prompts[i % 3];
    const r = await timedCall(p.s, p.u, 128);
    const parsed = tryParseJson(r.text);
    if (parsed) parseOk++;
    if (i < 6)
      console.log(
        `  #${i + 1}: ${r.ms.toFixed(0)}ms | parsed: ${parsed ? "YES" : "NO"}`
      );
    results.push(r);
  }

  const okCalls = results.filter((r) => r.success).length;
  console.log(`  ...`);
  console.log(
    `  JSON parse rate: ${parseOk}/${okCalls} (${((parseOk / Math.max(1, okCalls)) * 100).toFixed(0)}%)`
  );
  return summarize("6-json-reliability", results);
}

// ═══════════════════════════════════════════════
// TEST 7: Max concurrency stress (10 parallel)
// ═══════════════════════════════════════════════
async function test7_maxConcurrency(): Promise<BenchmarkResult> {
  console.log("\n=== Test 7: Max concurrency (10 parallel) ===");
  const wallStart = performance.now();
  const batch = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      timedCall(
        `Agent${i}. JSON only.`,
        `Pick action. JSON: {"action":"gather","thought":"reason"}`,
        64
      )
    )
  );
  const wallMs = performance.now() - wallStart;
  const fails = batch.filter((r) => !r.success).length;
  console.log(
    `  10 parallel: ${wallMs.toFixed(0)}ms wall | min: ${Math.min(...batch.filter((r) => r.success).map((r) => r.ms)).toFixed(0)}ms | max: ${Math.max(...batch.filter((r) => r.success).map((r) => r.ms)).toFixed(0)}ms | fails: ${fails}`
  );
  return summarize("7-max-concurrency-10", batch);
}

// ═══════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════
async function main() {
  console.log("╔═══════════════════════════════════════════════════╗");
  console.log("║  Anthropic SDK Benchmark — Haiku 4.5             ║");
  console.log("╚═══════════════════════════════════════════════════╝");
  console.log(`Model:  ${MODEL}`);
  console.log(`Proxy:  ${proxyUrl ? "YES" : "NO"}`);
  console.log(`Time:   ${new Date().toISOString()}`);

  const all: BenchmarkResult[] = [];

  all.push(await test1_minimal());
  all.push(await test2_agentDecision());
  all.push(await test3_parallelTick());
  all.push(await test4_consolidation());
  all.push(await test5_sustained());
  all.push(await test6_jsonReliability());
  all.push(await test7_maxConcurrency());

  // ─── Summary ───
  console.log("\n" + "═".repeat(110));
  console.log("SUMMARY");
  console.log("═".repeat(110));
  console.log(
    "Test".padEnd(25) +
      "N".padStart(4) +
      "Avg".padStart(9) +
      "P50".padStart(9) +
      "P95".padStart(9) +
      "Min".padStart(9) +
      "Max".padStart(9) +
      "Fail".padStart(5) +
      "AvgIn".padStart(7) +
      "AvgOut".padStart(7)
  );
  console.log("─".repeat(110));
  for (const r of all) {
    console.log(
      r.test.padEnd(25) +
        String(r.calls).padStart(4) +
        `${r.avgMs.toFixed(0)}ms`.padStart(9) +
        `${r.p50Ms.toFixed(0)}ms`.padStart(9) +
        `${r.p95Ms.toFixed(0)}ms`.padStart(9) +
        `${r.minMs.toFixed(0)}ms`.padStart(9) +
        `${r.maxMs.toFixed(0)}ms`.padStart(9) +
        String(r.failures).padStart(5) +
        r.avgInputTokens.toFixed(0).padStart(7) +
        r.avgOutputTokens.toFixed(0).padStart(7)
    );
  }

  // ─── Projections ───
  const d = all.find((r) => r.test === "2-agent-decision")!;
  const c = all.find((r) => r.test === "4-consolidation")!;
  const p = all.find((r) => r.test === "3-parallel-5x3")!;
  const s = all.find((r) => r.test === "5-sustained-day")!;

  if (d.avgMs > 0 && c.avgMs > 0) {
    console.log("\n" + "═".repeat(110));
    console.log("100-DAY SIMULATION PROJECTIONS");
    console.log("═".repeat(110));

    const hIn = 0.8 / 1e6;
    const hOut = 4.0 / 1e6;
    const sIn = 3.0 / 1e6;
    const sOut = 15.0 / 1e6;

    // Calls
    const decCalls = 5 * 4 * 100; // 2000
    const conCalls = 5 * 100 * 3; // 1500
    const idCalls = 5 * 10; // 50

    // Cost
    const decCost =
      decCalls * d.avgInputTokens * hIn + decCalls * d.avgOutputTokens * hOut;
    const conCost =
      conCalls * c.avgInputTokens * hIn + conCalls * c.avgOutputTokens * hOut;
    const idCost = idCalls * 3000 * sIn + idCalls * 800 * sOut;

    console.log(`  Decisions:     ${decCalls} calls  $${decCost.toFixed(2)}`);
    console.log(`  Consolidation: ${conCalls} calls  $${conCost.toFixed(2)}`);
    console.log(
      `  Identity:      ${idCalls} calls  $${idCost.toFixed(2)} (Sonnet)`
    );
    console.log(
      `  TOTAL COST:    ${decCalls + conCalls + idCalls} calls  $${(decCost + conCost + idCost).toFixed(2)}`
    );

    // Runtime
    // Parallel: each tick = 1 batch of 5, wall-clock ≈ max single call
    const dayWallMs = s.totalMs / s.calls * 5; // rough: avg_call * 5 agents but parallel
    const actualDayWall = s.totalMs; // we measured 20 calls in test5
    const conDayMs = 3 * c.avgMs; // 3 consolidation calls per agent, but 5 agents parallel = ~3 sequential
    const parallelDayMs = actualDayWall / 1 + conDayMs; // 1 day measured + consolidation
    const parallelTotalMin = (parallelDayMs * 100) / 60000;
    const serialTotalMin =
      (decCalls * d.avgMs + conCalls * c.avgMs) / 60000;

    console.log(`\n  Per-day wall-clock (parallel): ~${(parallelDayMs / 1000).toFixed(1)}s`);
    console.log(`  Serial runtime:   ${serialTotalMin.toFixed(1)} minutes`);
    console.log(`  Parallel runtime: ${parallelTotalMin.toFixed(1)} minutes`);
    console.log(`  Avg decision latency: ${(d.avgMs / 1000).toFixed(2)}s`);
    console.log(`  Avg consolidation latency: ${(c.avgMs / 1000).toFixed(2)}s`);
  }
}

main().catch(console.error);
