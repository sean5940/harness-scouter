import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { L, type Localized } from "./i18n.js";
import { basename, join } from "node:path";

/**
 * 하네스 구조 스캔.
 *
 * 지금까지의 지표는 전부 트랜스크립트에서 나온 **행동 흔적**이다. 그것만으로는 다른
 * 사람의 하네스를 평가할 수 없다. "규칙 위반 시도 없음 97점"은 훅을 열두 개 깔고 잘
 * 지킨 하네스와 훅을 하나도 안 깐 하네스를 구별하지 못한다. 후자가 자동으로 만점을
 * 받는다. Martin Fowler 의 harness engineering 글도 같은 것을 미해결로 남겼다.
 * "If sensors never fire, is that a sign of high quality or inadequate detection
 * mechanisms?"
 *
 * 답하려면 행동 말고 하네스 자체를 봐야 한다. 여기서는 저장소와 설정에서 센서와
 * 가이드의 목록을 뽑아, 행동 지표의 분모로 쓸 수 있게 한다.
 *
 * 축 이름은 그 글에서 가져왔다.
 *  - 방향: feedforward(행동 전에 조종) / feedback(행동 후 관찰해 자가수정)
 *  - 실행: computational(결정론적·빠름) / inferential(의미론적·느림·비결정론적)
 *  - 생명주기: 통합 전 / 자가수정 루프 / 통합 후 / 지속 모니터링
 */

export type SensorDirection = "feedforward" | "feedback";
export type SensorExecution = "computational" | "inferential";
export type LifecycleStage =
  "before" | "self-correct" | "post-integration" | "monitoring";

export const STAGE_LABELS: Record<LifecycleStage, Localized> = {
  before: L("통합 전", "Pre-integration"),
  "self-correct": L("자가수정 루프", "Self-correcting loop"),
  "post-integration": L("통합 후", "Post-integration"),
  monitoring: L("지속 모니터링", "Continuous monitoring"),
};

export interface HarnessSensor {
  name: string;
  /**
   * `skill` 은 사람이나 에이전트가 불러야 도는 센서다.
   * 자동 발동(hook·ci)과 갈라 세는 이유는, 기억해야 도는 센서는 안 도는 날이 있기 때문이다.
   */
  kind: "hook" | "permission" | "script" | "ci" | "skill";
  direction: SensorDirection;
  execution: SensorExecution;
  stage: LifecycleStage;
  /** 어디서 읽었는지. 사람이 열어볼 수 있어야 한다. */
  source: string;
}

export interface HarnessGuide {
  name: string;
  kind: "rule-doc" | "skill";
  /** 분량. 규칙 문서가 길수록 지켜지지 않는 경향이 있어 함께 본다. */
  lines: number;
  source: string;
}

export interface HarnessInventory {
  root: string;
  sensors: HarnessSensor[];
  guides: HarnessGuide[];
  /** 스캔이 닿지 못한 곳. 없는 것과 못 본 것을 구별해야 한다. */
  /** 못 본 것. 커버리지의 빈칸을 화면에 그대로 적기 위한 목록. */
  notScanned: Localized[];
}

/**
 * 훅 이벤트를 방향으로 옮긴다.
 *
 * 경계 사례가 있다. PreToolUse 훅은 제안된 행동을 검사해 막으므로 센서처럼 동작하지만,
 * 그 효과는 행동이 일어나기 전에 방향을 트는 것이라 feedforward 로 둔다. PostToolUse 는
 * 결과를 보고 고치게 하므로 feedback 이다.
 */
function directionOfHookEvent(event: string): SensorDirection {
  return event.startsWith("Pre") || event === "UserPromptSubmit"
    ? "feedforward"
    : "feedback";
}

function stageOfHookEvent(event: string): LifecycleStage {
  if (event === "SessionStart" || event === "UserPromptSubmit") return "before";
  if (event === "Stop" || event === "SessionEnd") return "monitoring";
  return "self-correct";
}

/** 결정론적으로 실행되면 computational, 모델을 부르면 inferential. */
const INFERENTIAL_HINT = /review|critique|judge|summar|analy|agent|llm|claude/i;

function executionOfCommand(command: string): SensorExecution {
  return INFERENTIAL_HINT.test(basename(command))
    ? "inferential"
    : "computational";
}

const VERIFIER_SCRIPT =
  /^(lint|eslint|typecheck|type-check|tsc|types?|test|tests|test:.*|format:check|prettier|check|validate|dep-?cruise[r]?|arch|fitness|coverage|mutation|stryker)$/;

/** 훅·권한·스크립트·CI 를 한 목록으로 모은다. */
export function scanHarness(
  root: string,
  extraSettings: string[] = [],
): HarnessInventory {
  const sensors: HarnessSensor[] = [];
  const guides: HarnessGuide[] = [];
  const notScanned: Localized[] = [];

  const readJson = (path: string): unknown => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  };

  const settingsPaths = [
    join(root, ".claude", "settings.json"),
    join(root, ".claude", "settings.local.json"),
    ...extraSettings,
  ];
  for (const path of settingsPaths) {
    const parsed = readJson(path);
    if (parsed === null || typeof parsed !== "object") continue;
    const config = parsed as Record<string, unknown>;

    const hooks = config["hooks"];
    if (typeof hooks === "object" && hooks !== null) {
      for (const [event, entries] of Object.entries(
        hooks as Record<string, unknown>,
      )) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          const list = (entry as { hooks?: unknown }).hooks;
          if (!Array.isArray(list)) continue;
          for (const hook of list) {
            const command = String(
              (hook as { command?: unknown }).command ?? "",
            );
            if (command === "") continue;
            sensors.push({
              name: basename(command.split(/\s+/)[0] ?? command),
              kind: "hook",
              direction: directionOfHookEvent(event),
              execution: executionOfCommand(command),
              stage: stageOfHookEvent(event),
              source: `${path} · ${event}`,
            });
          }
        }
      }
    }

    // deny·ask 규칙도 행동 전에 막으므로 센서다. allow 는 통과 목록이라 아니다.
    const permissions = config["permissions"];
    if (typeof permissions === "object" && permissions !== null) {
      for (const bucket of ["deny", "ask"] as const) {
        const rules = (permissions as Record<string, unknown>)[bucket];
        if (!Array.isArray(rules)) continue;
        for (const rule of rules) {
          sensors.push({
            name: String(rule),
            kind: "permission",
            direction: "feedforward",
            execution: "computational",
            stage: "before",
            source: `${path} · permissions.${bucket}`,
          });
        }
      }
    }
  }

  const pkg = readJson(join(root, "package.json"));
  if (pkg !== null && typeof pkg === "object") {
    const scripts = (pkg as { scripts?: unknown }).scripts;
    if (typeof scripts === "object" && scripts !== null) {
      for (const name of Object.keys(scripts as Record<string, unknown>)) {
        if (!VERIFIER_SCRIPT.test(name)) continue;
        sensors.push({
          name: `npm run ${name}`,
          kind: "script",
          direction: "feedback",
          execution: "computational",
          stage: "self-correct",
          source: join(root, "package.json"),
        });
      }
    }
  }

  const ciDir = join(root, ".github", "workflows");
  if (existsSync(ciDir)) {
    for (const file of readdirSync(ciDir)) {
      if (!/\.ya?ml$/.test(file)) continue;
      sensors.push({
        name: file.replace(/\.ya?ml$/, ""),
        kind: "ci",
        direction: "feedback",
        execution: "computational",
        stage: "post-integration",
        source: join(ciDir, file),
      });
    }
  } else {
    notScanned.push(
      L(
        "CI 설정 없음 (통합 후 단계를 못 봄)",
        "No CI config (the post-integration stage is invisible)",
      ),
    );
  }

  const countLines = (path: string): number => {
    try {
      return readFileSync(path, "utf8").split("\n").length;
    } catch {
      return 0;
    }
  };

  for (const name of ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"]) {
    for (const dir of [root, join(root, ".agent"), join(root, ".claude")]) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      guides.push({
        name,
        kind: "rule-doc",
        lines: countLines(path),
        source: path,
      });
    }
  }

  // 스킬 중 검사 성격인 것은 가이드가 아니라 센서다. 결과를 보고 지적하는 일을 하고,
  // 대부분 모델을 불러 의미를 본다. 다만 사람이 불러야 도므로 자동 센서와 갈라 센다.
  const REVIEW_SKILL =
    /review|critique|audit|retro|guard|checklist|verify|inspect/i;
  const seenSkills = new Set<string>();
  for (const dir of [
    join(root, ".claude", "skills"),
    join(root, ".agent", "skills"),
    join(root, ".codex", "skills"),
  ]) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const skill = join(dir, entry, "SKILL.md");
      if (!existsSync(skill)) continue;
      try {
        if (!statSync(skill).isFile()) continue;
      } catch {
        continue;
      }
      // 같은 스킬이 여러 런타임 디렉토리에 심볼릭 링크로 걸려 있어 이름으로 중복을 뺀다.
      if (seenSkills.has(entry)) continue;
      seenSkills.add(entry);
      if (REVIEW_SKILL.test(entry)) {
        sensors.push({
          name: entry,
          kind: "skill",
          direction: "feedback",
          execution: "inferential",
          stage: "self-correct",
          source: skill,
        });
        continue;
      }
      guides.push({
        name: entry,
        kind: "skill",
        lines: countLines(skill),
        source: skill,
      });
    }
  }

  notScanned.push(
    L(
      "런타임 피드백(SLO·로그 이상)은 트랜스크립트 밖이라 못 봄",
      "Runtime feedback (SLOs, log anomalies) lives outside the transcript and is invisible",
    ),
  );

  return { root, sensors, guides, notScanned };
}

export interface CoherenceReport {
  /** 어느 규칙 문서에도 이름이 안 나오는 센서. 설명 없이 막는 게이트다. */
  undocumentedSensors: string[];
  /** 검사에 쓴 문서 수. 범위가 결론을 크게 바꾸므로 함께 낸다. */
  documentsChecked: number;
  sensorsChecked: number;
}

/**
 * 가이드와 센서가 어긋나 있는가.
 *
 * Fowler 의 미해결 질문 중 하나다. "How do we keep a harness coherent as it grows,
 * with guides and sensors in sync, not contradicting each other?"
 *
 * 여기서는 정확히 셀 수 있는 쪽만 센다. 어느 규칙 문서에도 이름이 안 나오는 센서는
 * 에이전트가 설명을 못 본 채 막히는 게이트다. 반대 방향(문서에만 있고 집행 없는 규칙)은
 * 산문에서 규칙을 식별해야 해서 신뢰성이 낮아 넣지 않는다.
 *
 * 검사 범위가 결론을 크게 바꾼다. 같은 저장소에서 규칙 문서 셋만 보면 미기재가 21종,
 * 레퍼런스까지 넣으면 7종, 스킬까지 넣으면 4종이다. 그래서 문서 수를 함께 낸다.
 */
export function checkCoherence(
  inventory: HarnessInventory,
  documentPaths: string[],
): CoherenceReport {
  let corpus = "";
  const unique = new Set(documentPaths);
  let read = 0;
  for (const path of unique) {
    try {
      corpus += `${readFileSync(path, "utf8")}\n`;
      read += 1;
    } catch {
      continue;
    }
  }
  const names = [
    ...new Set(
      inventory.sensors.filter((s) => s.kind === "hook").map((s) => s.name),
    ),
  ];
  return {
    undocumentedSensors: names.filter(
      (n) =>
        !corpus.includes(n) && !corpus.includes(n.replace(/\.(sh|py)$/, "")),
    ),
    documentsChecked: read,
    sensorsChecked: names.length,
  };
}

/** 규칙으로 읽히는 문서만 모은다. 기획·회고 문서는 뺀다. */
export function ruleDocumentPaths(root: string): string[] {
  const out: string[] = [];
  const push = (path: string) => {
    if (existsSync(path)) out.push(path);
  };
  for (const name of ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"]) {
    push(join(root, name));
    push(join(root, ".agent", name));
    push(join(root, ".claude", name));
  }
  const walk = (dir: string, depth: number): void => {
    if (depth > 2 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(path, depth + 1);
      else if (entry.endsWith(".md")) out.push(path);
    }
  };
  walk(join(root, ".agent", "references"), 0);
  for (const dir of [".claude", ".agent", ".codex"]) {
    walk(join(root, dir, "skills"), 0);
  }
  return out;
}

export interface HarnessCoverage {
  sensorCount: number;
  guideCount: number;
  byDirection: Record<SensorDirection, number>;
  byExecution: Record<SensorExecution, number>;
  byStage: Record<LifecycleStage, number>;
  /** 센서가 하나도 없는 생명주기 단계. 여기가 하네스의 구멍이다. */
  emptyStages: LifecycleStage[];
}

export function summarizeHarness(inventory: HarnessInventory): HarnessCoverage {
  const byDirection: Record<SensorDirection, number> = {
    feedforward: 0,
    feedback: 0,
  };
  const byExecution: Record<SensorExecution, number> = {
    computational: 0,
    inferential: 0,
  };
  const byStage: Record<LifecycleStage, number> = {
    before: 0,
    "self-correct": 0,
    "post-integration": 0,
    monitoring: 0,
  };
  for (const s of inventory.sensors) {
    byDirection[s.direction] += 1;
    byExecution[s.execution] += 1;
    byStage[s.stage] += 1;
  }
  return {
    sensorCount: inventory.sensors.length,
    guideCount: inventory.guides.length,
    byDirection,
    byExecution,
    byStage,
    emptyStages: (Object.keys(byStage) as LifecycleStage[]).filter(
      (k) => byStage[k] === 0,
    ),
  };
}
