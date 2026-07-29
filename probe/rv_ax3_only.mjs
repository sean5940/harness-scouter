import { ScouterDb } from "../packages/core/dist/db.js";
import { classifyBash, isCodeFile } from "../packages/core/dist/definitions.js";

const EDIT = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const db = new ScouterDb("/tmp/scouter-test.sqlite");

// 변형: 차단된 verifier는 segmentLastVerifier를 갱신하지 않음. 나머지는 원본과 동일.
let den = 0,
  num = 0;
for (const s of db.listSessions()) {
  const st = new Map();
  for (const c of db.toolCallsOf(s.session_id)) {
    const key = c.agent_id ?? "main";
    let a = st.get(key);
    if (!a) {
      a = { ce: -1, lv: -1, has: false };
      st.set(key, a);
    }
    if (EDIT.has(c.name)) {
      if (c.file_path && isCodeFile(c.file_path)) {
        a.ce = c.seq;
        a.has = true;
      }
      continue;
    }
    if (c.name !== "Bash") continue;
    const k = classifyBash(c.command);
    if (k.fileWriteRule !== null) {
      a.ce = c.seq;
      a.has = true;
    }
    if (k.verifierKinds.length > 0 && c.denial_kind === null) a.lv = c.seq;
    if (k.isCommit && !k.isCommitAmend) {
      if (a.has) {
        den += 1;
        if (a.lv > a.ce) num += 1;
      }
      a.ce = -1;
      a.lv = -1;
      a.has = false;
    }
  }
}
console.log({ den, num, score: (num / den).toFixed(4) });
