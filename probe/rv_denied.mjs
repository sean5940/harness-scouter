import { DatabaseSync } from "node:sqlite";
import { classifyBash } from "../packages/core/dist/definitions.js";

const db = new DatabaseSync("/tmp/scouter-test.sqlite");
const rows = db
  .prepare(
    `SELECT c.denial_kind, c.command FROM tool_call c WHERE c.name='Bash'`,
  )
  .all();

let deniedTotal = 0,
  deniedVerifier = 0,
  deniedSourceRead = 0,
  deniedWrite = 0,
  deniedRecursive = 0,
  deniedCommit = 0;
for (const r of rows) {
  if (r.denial_kind === null) continue;
  deniedTotal += 1;
  const k = classifyBash(r.command);
  if (k.verifierKinds.length > 0) deniedVerifier += 1;
  if (k.isSourceRead) deniedSourceRead += 1;
  if (k.fileWriteRule !== null) deniedWrite += 1;
  if (k.isRecursiveSearch) deniedRecursive += 1;
  if (k.isCommit) deniedCommit += 1;
}
console.log({
  deniedTotal,
  deniedVerifier,
  deniedSourceRead,
  deniedWrite,
  deniedRecursive,
  deniedCommit,
});
