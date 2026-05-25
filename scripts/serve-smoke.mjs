/**
 * Quick smoke test for `dsc serve`.
 *
 * Run:        node scripts/serve-smoke.mjs
 * Requires:   `dsc serve --port 9096` running in another terminal
 *
 * Lives in scripts/ (not tests/, not src/) so node --test's
 * auto-discovery doesn't pick it up — it requires a live daemon
 * and is meant to be invoked manually.
 */
import { WebSocket } from "ws";

const PORT = Number(process.env.PORT) || 9096;
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

let tokenCount = 0;

ws.on("open", () => {
  console.error("connected");
  ws.send(JSON.stringify({ type: "prompt", text: "Say hello in exactly three words." }));
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  switch (msg.type) {
    case "hello":
      console.error(`hello: protocol v${msg.protocol_version}, dsc ${msg.version}`);
      break;
    case "token":
      process.stdout.write(msg.text);
      tokenCount++;
      break;
    case "thinking":
      process.stderr.write(`[thinking: ${msg.text.length}B]\n`);
      break;
    case "tool":
      console.error(`\n[tool: ${msg.name}]`);
      break;
    case "tool_result":
      console.error(`\n[tool result: ${msg.name}]`);
      break;
    case "notice":
      console.error(`\n[notice: ${msg.text.slice(0, 80)}]`);
      break;
    case "turn_end":
      console.error(`\n— turn end —`);
      ws.close();
      break;
    default:
      console.error(`\n[unknown: ${msg.type}]`);
  }
});

ws.on("error", (e) => {
  console.error("error:", e.message);
  process.exit(1);
});

ws.on("close", () => {
  console.error(`\nclosed (${tokenCount} tokens received)`);
  process.exit(0);
});

setTimeout(() => {
  console.error("\ntimeout — did not complete");
  ws.close();
  process.exit(1);
}, 20000);
