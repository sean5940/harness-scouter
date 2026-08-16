import { ScouterDb } from "../packages/core/dist/db.js";
import {
  computeSessionMetrics,
  emptyAxes,
  addCounts,
  axisScore,
} from "../packages/core/dist/metrics.js";

const db = new ScouterDb("/tmp/scouter-test.sqlite");
const sessions = db.listSessions();

const base = emptyAxes();
const noDenied = emptyAxes();
let totalCalls = 0,
  droppedCalls = 0;

for (const s of sessions) {
  const calls = db.toolCallsOf(s.session_id);
  totalCalls += calls.length;
  addCounts(base, computeSessionMetrics(s.session_id, calls).axes);
  const filtered = calls.filter((c) => c.denial_kind === null);
  droppedCalls += calls.length - filtered.length;
  addCounts(noDenied, computeSessionMetrics(s.session_id, filtered).axes);
}

console.log(
  "sessions",
  sessions.length,
  "calls",
  totalCalls,
  "dropped",
  droppedCalls,
);
for (const k of Object.keys(base)) {
  const b = base[k],
    n = noDenied[k];
  console.log(
    k.padEnd(24),
    `base ${b.num}/${b.den} = ${axisScore(k, b)?.toFixed(4)}`,
    `| noDenied ${n.num}/${n.den} = ${axisScore(k, n)?.toFixed(4)}`,
  );
}
