import { ScouterDb } from "../packages/core/dist/db.js";
import { classifyBash, isCodeFile } from "../packages/core/dist/definitions.js";

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const db = new ScouterDb("/tmp/scouter-test.sqlite");

let numTotal = 0,
  causedByDenied = 0,
  deniedItself = 0;
let ax3den = 0,
  ax3num = 0,
  freshFromDeniedVerifier = 0;
const pairs = [];
const ax3ex = [];

for (const s of db.listSessions()) {
  const calls = db.toolCallsOf(s.session_id);
  const states = new Map();
  for (const call of calls) {
    const key = call.agent_id ?? "main";
    let st = states.get(key);
    if (!st) {
      st = {
        segLastCodeEdit: -1,
        segLastVerifier: -1,
        segLastVerifierDenied: false,
        segHasCodeEdit: false,
        // kind -> {denied, command}
        block: new Map(),
      };
      states.set(key, st);
    }
    const denied = call.denial_kind !== null;

    if (EDIT_TOOLS.has(call.name)) {
      if (call.file_path !== null && isCodeFile(call.file_path)) {
        st.segLastCodeEdit = call.seq;
        st.segHasCodeEdit = true;
      }
      st.block = new Map();
      continue;
    }
    if (call.name !== "Bash") continue;
    const k = classifyBash(call.command);
    if (k.fileWriteRule !== null) {
      st.segLastCodeEdit = call.seq;
      st.segHasCodeEdit = true;
      st.block = new Map();
    }
    if (k.verifierKinds.length > 0) {
      st.segLastVerifier = call.seq;
      st.segLastVerifierDenied = denied;
      for (const vk of k.verifierKinds) {
        const prev = st.block.get(vk);
        if (prev !== undefined) {
          numTotal += 1;
          if (denied) deniedItself += 1;
          else if (prev.denied) {
            causedByDenied += 1;
            if (pairs.length < 6)
              pairs.push({
                session: s.session_id.slice(0, 8),
                kind: vk,
                deniedCmd: prev.command,
                retryCmd: call.command,
              });
          }
        } else st.block.set(vk, { denied, command: call.command });
      }
    }
    if (k.isCommit && !k.isCommitAmend) {
      if (st.segHasCodeEdit) {
        ax3den += 1;
        if (st.segLastVerifier > st.segLastCodeEdit) {
          ax3num += 1;
          if (st.segLastVerifierDenied) {
            freshFromDeniedVerifier += 1;
            if (ax3ex.length < 6)
              ax3ex.push({ session: s.session_id.slice(0, 8) });
          }
        }
      }
      st.segLastCodeEdit = -1;
      st.segLastVerifier = -1;
      st.segLastVerifierDenied = false;
      st.segHasCodeEdit = false;
    }
  }
}

console.log({ numTotal, causedByDenied, deniedItself });
console.log({ ax3den, ax3num, freshFromDeniedVerifier });
console.log(JSON.stringify(pairs, null, 2));
console.log(ax3ex);
