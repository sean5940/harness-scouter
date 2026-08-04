/**
 * 문서에 적힌 값이 코드·실행 결과와 맞는지 기계로 대조한다.
 *
 * 이 저장소에서 반복해 나온 결함이 문서와 코드의 drift 다. 앵커값을 1,000/4,500 으로
 * 고쳤는데 설명은 500/4,000 으로 남고, 같은 크기를 900MB 와 890MB 로 적고, 오염 없는
 * 구성요소가 없는데 하나 있다고 적었다. 전부 문서만 읽어서는 안 보이고 코드를 돌려야 나온다.
 *
 * 그래서 사람이 눈으로 대조하지 않는다. 여기서 실패하면 문서가 거짓말을 하고 있는 것이다.
 *
 *   node scripts/checkDocs.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "packages/cli/dist/index.js");

let failures = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "o" : "X"}  ${label}${detail ? `  ${detail}` : ""}`);
};

if (!existsSync(CLI)) {
  console.error("빌드 산출물이 없습니다. npm run build 를 먼저 돌리세요.");
  process.exit(1);
}

const readme = readFileSync(join(ROOT, "README.md"), "utf8");

/** 문서의 수치 토큰. 천단위 쉼표는 숫자 사이에 있을 때만 붙인다. */
function numbers(text) {
  const cleaned = text.replace(/[A-Za-z_][A-Za-z0-9_]*\d[A-Za-z0-9_]*/g, " ");
  const out = new Map();
  for (const m of cleaned.matchAll(/-?\d+(?:,\d{3})*(?:\.\d+)?%?/g)) {
    out.set(m[0], (out.get(m[0]) ?? 0) + 1);
  }
  return out;
}

console.log("문서 대조\n");

// 1. 맨 위 예시 화면이 실제 출력과 같은가.
//    손으로 옮기면 정의를 고칠 때마다 어긋난다.
const sample = readme.match(/```\n(  HARNESS SCOUTER[\s\S]*?)```/);
if (sample === null) {
  check(false, "예시 화면을 README 에서 못 찾음");
} else {
  const actual = execFileSync(
    process.execPath,
    [CLI, "status", "--all", "--lang", "ko"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  )
    .split("\n")
    .filter((l) => l.trim() !== "")
    .join("\n");
  const shown = sample[1].trimEnd();
  check(shown === actual, "예시 화면이 실제 출력과 같다");
  if (shown !== actual) {
    const a = shown.split("\n");
    const b = actual.split("\n");
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) {
        console.log(`       README: ${a[i] ?? "(없음)"}`);
        console.log(`       실제  : ${b[i] ?? "(없음)"}`);
        break;
      }
    }
  }
}

// 2. 오염 없는 구성요소가 몇 개인지 산문이 맞게 적었는가.
const { COMPONENT_CRITERIA } = await import(
  join(ROOT, "packages/core/dist/growth.js")
);
const clean = Object.entries(COMPONENT_CRITERIA).filter(
  ([, c]) => c.contamination.length === 0,
);
const claimsAllContaminated = /14개 구성요소에 \*\*전부\*\*/.test(readme);
check(
  clean.length === 0 ? claimsAllContaminated : !claimsAllContaminated,
  "오염 플래그 서술이 실제와 맞다",
  `오염 없는 구성요소 ${clean.length}개${clean.length ? `: ${clean.map(([k]) => k).join(", ")}` : ""}`,
);

// 3. 능력 표에 적힌 이름이 실제 프로필에 있는가.
const { CLAUDE_CODE_PROFILE, availableCapabilities } = await import(
  join(ROOT, "packages/core/dist/capability.js")
);
const documented = new Set(
  [...readme.matchAll(/^\| `([a-z-]+)`\s+\|/gm)].map((m) => m[1]),
);
const real = new Set([
  ...Object.values(CLAUDE_CODE_PROFILE.tools),
  ...CLAUDE_CODE_PROFILE.toolPatterns.map((p) => p.capability),
  ...CLAUDE_CODE_PROFILE.shellCommands.map((p) => p.capability),
]);
const missing = [...real].filter((c) => !documented.has(c));
check(missing.length === 0, "능력 표가 프로필을 다 덮는다", missing.join(" "));

// 4. 커버리지 수치가 실제와 맞는가.
const covLine = readme.match(/능력에 매핑됨\s+([\d,]+)\s+([\d.]+)%/);
if (covLine === null) {
  check(false, "커버리지 수치를 README 에서 못 찾음");
} else {
  const { DatabaseSync } = await import("node:sqlite");
  const dbPath = join(
    process.env.HOME ?? "",
    ".harness-scouter/scouter.sqlite",
  );
  if (!existsSync(dbPath)) {
    console.log("  -  커버리지 대조 건너뜀 (DB 없음)");
  } else {
    const { createResolver, measureCoverage } = await import(
      join(ROOT, "packages/core/dist/capability.js")
    );
    const db = new DatabaseSync(dbPath);
    const rows = db.prepare("SELECT name, command FROM tool_call").all();
    db.close();
    const c = measureCoverage(createResolver(CLAUDE_CODE_PROFILE), rows);
    check(
      covLine[1].replace(/,/g, "") === String(c.mapped),
      "커버리지 매핑 수",
      `README ${covLine[1]} · 실제 ${c.mapped.toLocaleString()}`,
    );
  }
}

// 5. 번역본이 원문의 수치를 그대로 갖고 있는가.
const src = numbers(readme);
for (const lang of ["en", "ja"]) {
  const path = join(ROOT, `README.${lang}.md`);
  if (!existsSync(path)) continue;
  const t = numbers(readFileSync(path, "utf8"));
  const miss = [...src].filter(([k, n]) => (t.get(k) ?? 0) < n).map(([k]) => k);
  check(
    miss.length === 0,
    `README.${lang}.md 수치 보존`,
    miss.slice(0, 6).join(" "),
  );
}

// 6. 번역본의 절 구조가 원문과 같은가.
//
//    번역 에이전트가 새 절을 엉뚱한 자리에 넣어도 수치 검사는 통과한다. 숫자는 다 있고
//    자리만 틀렸기 때문이다. 실제로 그렇게 한 번 어긋났다.
const headingCount = (text) =>
  (text.match(/^#{2,3} /gm) ?? []).length;
const srcHeadings = headingCount(readme);
for (const lang of ["en", "ja"]) {
  const path = join(ROOT, `README.${lang}.md`);
  if (!existsSync(path)) continue;
  const n = headingCount(readFileSync(path, "utf8"));
  check(
    n === srcHeadings,
    `README.${lang}.md 절 개수`,
    `${n} 대 ${srcHeadings}`,
  );
}

// 7. availableCapabilities 가 Claude Code 에서 축을 다 재는가.
const { AXIS_REQUIRES, axisMeasurable } = await import(
  join(ROOT, "packages/core/dist/capability.js")
);
const have = availableCapabilities(CLAUDE_CODE_PROFILE);
const unmeasurable = Object.keys(AXIS_REQUIRES).filter(
  (a) => !axisMeasurable(a, have),
);
check(
  unmeasurable.length === 0,
  "Claude Code 프로필이 모든 축을 잰다",
  unmeasurable.join(" "),
);

console.log(failures === 0 ? "\n전부 통과" : `\n실패 ${failures}건`);
process.exit(failures === 0 ? 0 : 1);
