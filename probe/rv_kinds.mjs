import { ScouterDb } from "../packages/core/dist/db.js";
import { classifyBash } from "../packages/core/dist/definitions.js";

const EDIT = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const db = new ScouterDb("/tmp/scouter-test.sqlite");
const regKinds = {};
const selfKinds = {};
let numTotal = 0;

for (const s of db.listSessions()) {
  const st = new Map();
  for (const c of db.toolCallsOf(s.session_id)) {
    const key = c.agent_id ?? "main";
    let a = st.get(key);
    if (!a) {
      a = { block: new Map() };
      st.set(key, a);
    }
    if (EDIT.has(c.name)) {
      a.block = new Map();
      continue;
    }
    if (c.name !== "Bash") continue;
    const k = classifyBash(c.command);
    if (k.fileWriteRule !== null) a.block = new Map();
    for (const vk of k.verifierKinds) {
      const prev = a.block.get(vk);
      if (prev !== undefined) {
        numTotal += 1;
        if (c.denial_kind !== null)
          selfKinds[c.denial_kind] = (selfKinds[c.denial_kind] ?? 0) + 1;
        if (prev.dk !== null) regKinds[prev.dk] = (regKinds[prev.dk] ?? 0) + 1;
      } else a.block.set(vk, { dk: c.denial_kind });
    }
  }
}
console.log({ numTotal });
console.log("registrar denial kinds:", regKinds);
console.log("numerator-call denial kinds:", selfKinds);
