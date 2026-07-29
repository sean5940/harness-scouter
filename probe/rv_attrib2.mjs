import { ScouterDb } from "../packages/core/dist/db.js";
import { classifyBash, isCodeFile } from "../packages/core/dist/definitions.js";
const EDIT_TOOLS = new Set(["Edit","Write","NotebookEdit","MultiEdit"]);
const db = new ScouterDb("/tmp/scouter-test.sqlite");
let numTotal=0, anyPriorDenied=0, deniedItself=0, registrarDenied=0;
for (const s of db.listSessions()) {
  const states = new Map();
  for (const call of db.toolCallsOf(s.session_id)) {
    const key = call.agent_id ?? "main";
    let st = states.get(key);
    if (!st) { st = { block: new Map() }; states.set(key, st); }
    const denied = call.denial_kind !== null;
    if (EDIT_TOOLS.has(call.name)) { st.block = new Map(); continue; }
    if (call.name !== "Bash") continue;
    const k = classifyBash(call.command);
    if (k.fileWriteRule !== null) st.block = new Map();
    for (const vk of k.verifierKinds) {
      const prev = st.block.get(vk);
      if (prev !== undefined) {
        numTotal += 1;
        if (denied) deniedItself += 1;
        if (prev.registrarDenied) registrarDenied += 1;
        if (prev.anyDenied) anyPriorDenied += 1;
        if (denied) prev.anyDenied = true;
      } else st.block.set(vk, { registrarDenied: denied, anyDenied: denied });
    }
  }
}
console.log({numTotal, deniedItself, registrarDenied, anyPriorDenied});
