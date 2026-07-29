// 축3 총량 영향: 현행(agent별 segment) vs 세션 공유 segment
import { ScouterDb } from "../packages/core/dist/db.js";
import { computeSessionMetrics } from "../packages/core/dist/metrics.js";
import { classifyBash, isCodeFile } from "../packages/core/dist/definitions.js";

const db = new ScouterDb(process.argv[2] ?? "/tmp/scouter-test.sqlite");
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

let baseNum = 0, baseDen = 0, shNum = 0, shDen = 0;

for (const meta of db.listSessions()) {
  const calls = db.toolCallsOf(meta.session_id);
  if (calls.length === 0) continue;

  // base: 현행 구현 그대로
  const m = computeSessionMetrics(meta.session_id, calls);
  baseNum += m.axes.verificationFreshness.num;
  baseDen += m.axes.verificationFreshness.den;

  // 변형: 축3 segment 상태만 세션 단위로 공유 (축2 lastRead/lastEdit은 agent별 유지)
  let segLastCodeEdit = -1, segLastVerifier = -1, segHasCodeEdit = false;
  for (const call of calls) {
    if (EDIT_TOOLS.has(call.name)) {
      if (call.file_path !== null && isCodeFile(call.file_path)) {
        segLastCodeEdit = call.seq;
        segHasCodeEdit = true;
      }
      continue;
    }
    if (call.name !== "Bash") continue;
    const kind = classifyBash(call.command);
    if (kind.fileWriteRule !== null) { segLastCodeEdit = call.seq; segHasCodeEdit = true; }
    if (kind.verifierKinds.length > 0) segLastVerifier = call.seq;
    if (kind.isCommit && !kind.isCommitAmend) {
      if (segHasCodeEdit) {
        shDen += 1;
        if (segLastVerifier > segLastCodeEdit) shNum += 1;
      }
      segLastCodeEdit = -1; segLastVerifier = -1; segHasCodeEdit = false;
    }
  }
}

const pct = (n, d) => (d === 0 ? "n/a" : (100 * n / d).toFixed(1) + "%");
console.log("base ax3          ", baseNum + "/" + baseDen, pct(baseNum, baseDen));
console.log("sharedSegment ax3 ", shNum + "/" + shDen, pct(shNum, shDen));
console.log("den delta         ", shDen - baseDen, "(+" + (100 * (shDen - baseDen) / baseDen).toFixed(1) + "%)");
