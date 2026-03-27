import Anthropic from "@anthropic-ai/sdk";

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("Set ANTHROPIC_API_KEY env var");
  process.exit(1);
}
const client = new Anthropic({
  apiKey: API_KEY,
  timeout: 120_000,
});

async function main() {
  console.log("Testing basic API call...");
  const start = performance.now();
  try {
    const r = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 32,
      messages: [{ role: "user", content: "Say hello in 5 words." }],
    });
    const ms = performance.now() - start;
    console.log(`Success in ${ms.toFixed(0)}ms`);
    console.log(`Response: ${r.content[0].type === "text" ? r.content[0].text : "non-text"}`);
    console.log(`Tokens: ${r.usage.input_tokens}in / ${r.usage.output_tokens}out`);
  } catch (err: any) {
    const ms = performance.now() - start;
    console.log(`Failed in ${ms.toFixed(0)}ms`);
    console.log(`Error: ${err.message}`);
    console.log(`Status: ${err.status}`);
    console.log(`Type: ${err.constructor.name}`);
    if (err.error) console.log(`Detail: ${JSON.stringify(err.error)}`);
  }
}
main();
