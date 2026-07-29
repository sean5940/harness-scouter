// 축3 위임 누수 재현: main 에이전트의 커밋 중 segmentHasCodeEdit=false로 버려진 것 가운데
// 직전 커밋 이후 sidechain 에이전트가 코드 파일을 편집한 건이 몇 건인지 센다.
import { ScouterDb } from "../packages/core/dist/db.js";
import { classifyBash, isCodeFile } from "../packages/core/dist/definitions.js";

const DB = process.argv[2] ?? "/tmp/scouter-test.sqlite";
const db = new ScouterDb(DB);
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

let mainCommits = 0;
let counted = 0;
let droppedNoMainEdit = 0;
let droppedButSubagentEdited = 0;
const examples = [];

for (const meta of db.listSessions()) {
  const calls = db.toolCallsOf(meta.session_id);
  if (calls.length === 0) continue;

  const states = new Map();
  // 세션 전체(모든 에이전트)에서 마지막 커밋 이후 sidechain이 편집한 코드 파일
  let subagentCodeEditsSinceCommit = [];

  for (const call of calls) {
    const key = call.agent_id ?? "main";
    let st = states.get(key);
    if (st === undefined) {
      st = { segHasCodeEdit: false, segLastCodeEdit: -1, segLastVerifier: -1 };
      states.set(key, st);
    }

    if (EDIT_TOOLS.has(call.name)) {
      if (call.file_path !== null && isCodeFile(call.file_path)) {
        st.segLastCodeEdit = call.seq;
        st.segHasCodeEdit = true;
        if (key !== "main")
          subagentCodeEditsSinceCommit.push({ agent: key, path: call.file_path });
      }
      continue;
    }
    if (call.name !== "Bash") continue;
    const kind = classifyBash(call.command);
    if (kind.fileWriteRule !== null) {
      st.segLastCodeEdit = call.seq;
      st.segHasCodeEdit = true;
      if (key !== "main")
        subagentCodeEditsSinceCommit.push({ agent: key, path: call.command?.slice(0, 60) });
    }
    if (kind.verifierKinds.length > 0) st.segLastVerifier = call.seq;

    if (kind.isCommit && !kind.isCommitAmend) {
      if (key === "main") {
        mainCommits += 1;
        if (st.segHasCodeEdit) counted += 1;
        else {
          droppedNoMainEdit += 1;
          if (subagentCodeEditsSinceCommit.length > 0) {
            droppedButSubagentEdited += 1;
            if (examples.length < 5)
              examples.push({
                session: meta.session_id.slice(0, 8),
                cmd: call.command?.slice(0, 90),
                subEdits: subagentCodeEditsSinceCommit.slice(0, 3),
                nSubEdits: subagentCodeEditsSinceCommit.length,
              });
          }
        }
      }
      st.segHasCodeEdit = false;
      st.segLastCodeEdit = -1;
      st.segLastVerifier = -1;
      subagentCodeEditsSinceCommit = [];
    }
  }
}

console.log({ mainCommits, counted, droppedNoMainEdit, droppedButSubagentEdited });
console.log(JSON.stringify(examples, null, 2));
