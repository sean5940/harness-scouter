/**
 * 도구 이름과 지표 사이에 끼우는 능력 층.
 *
 * 지금까지 지표는 도구 이름으로 직접 정의돼 있었다(`FILE_FIND_TOOLS = {"Glob"}`). 그래서
 * 이름이 다른 하네스를 재면 그 하네스가 나빠서가 아니라 이쪽이 못 알아봐서 0 이 나온다.
 *
 * 이름 의존 자체를 없앨 수는 없다. "이 호출이 파일 읽기다"를 알려면 어딘가에서 이름을
 * 봐야 한다. 바꿀 수 있는 것은 그 앎이 코드에 박혀 있느냐 설정으로 나와 있느냐다.
 *
 * 그리고 이 파일의 진짜 목적은 매핑이 아니라 **미매핑 계측**이다. graphify 사고의 본질은
 * 이름을 틀린 것이 아니라 틀린 줄 몰랐다는 것이다. CLI 호출 1,220건이 4건으로 보이는데
 * 화면은 아무 말도 하지 않았다. 매핑표는 언제든 또 낡으므로, 낡았을 때 소리가 나게 한다.
 */
import { L, type Localized } from "./i18n.js";

/**
 * 지표가 보는 능력.
 *
 * 도구 이름이 아니라 이 목록으로 축을 정의한다. 새 하네스를 붙일 때 채우는 것은
 * 이름에서 이 목록으로 가는 매핑 하나다.
 */
export type Capability =
  | "file-find"
  | "content-search"
  | "index-search"
  | "index-fetch"
  | "file-read"
  | "file-edit"
  | "shell"
  | "subagent"
  | "other";

export const CAPABILITY_LABELS: Record<Capability, Localized> = {
  "file-find": L("파일 찾기", "Find files"),
  "content-search": L("내용 스캔", "Scan contents"),
  "index-search": L("인덱스 검색", "Index search"),
  "index-fetch": L("인덱스 조회", "Index fetch"),
  "file-read": L("파일 읽기", "Read file"),
  "file-edit": L("파일 편집", "Edit file"),
  shell: L("셸 실행", "Run shell"),
  subagent: L("subagent 위임", "Delegate to subagent"),
  other: L("그 밖", "Other"),
};

export interface ToolPattern {
  /** 도구 이름에 맞출 정규식 소스. */
  pattern: string;
  capability: Capability;
}

export interface HarnessProfile {
  id: string;
  label: Localized;
  /** 이름이 정확히 일치할 때. 가장 먼저 본다. */
  tools: Record<string, Capability>;
  /** 이름이 동적일 때(MCP 도구 등). tools 다음에 순서대로 본다. */
  toolPatterns: ToolPattern[];
  /**
   * 셸 안에서 도는 CLI.
   *
   * 이 칸이 비어 있으면 graphify 사고가 그대로 재발한다. 도구로 부르든 셸로 부르든
   * 같은 일을 한 것인데, 셸 쪽을 안 보면 실사용량의 300분의 1만 세게 된다.
   */
  shellCommands: ToolPattern[];
}

/**
 * 매핑 결과. 어디에 걸렸는지를 남긴다.
 *
 * 어느 규칙이 잡았는지 모르면 프로필을 고칠 때 무엇을 고쳐야 할지 알 수 없다.
 */
export interface CapabilityMatch {
  capability: Capability;
  via: "tool" | "toolPattern" | "shellCommand";
  rule: string;
}

export interface CapabilityResolver {
  profile: HarnessProfile;
  /** 도구 호출 하나를 능력으로 옮긴다. 모르면 null. */
  resolve(toolName: string, command: string | null): CapabilityMatch | null;
}

function compile(patterns: ToolPattern[]): Array<{
  re: RegExp;
  capability: Capability;
  source: string;
}> {
  return patterns.map((p) => ({
    re: new RegExp(p.pattern),
    capability: p.capability,
    source: p.pattern,
  }));
}

export function createResolver(profile: HarnessProfile): CapabilityResolver {
  const toolRes = compile(profile.toolPatterns);
  const shellRes = compile(profile.shellCommands);

  return {
    profile,
    resolve(toolName, command) {
      const exact = profile.tools[toolName];
      if (exact !== undefined) {
        // 셸 도구는 이름만으로 끝내지 않는다. 안에서 무엇을 돌렸는지가 실제 능력이다.
        if (exact === "shell" && command !== null) {
          for (const r of shellRes) {
            if (r.re.test(command)) {
              return {
                capability: r.capability,
                via: "shellCommand",
                rule: r.source,
              };
            }
          }
        }
        return { capability: exact, via: "tool", rule: toolName };
      }
      for (const r of toolRes) {
        if (r.re.test(toolName)) {
          return {
            capability: r.capability,
            via: "toolPattern",
            rule: r.source,
          };
        }
      }
      return null;
    },
  };
}

/**
 * 프로필이 관측을 얼마나 덮는가.
 *
 * 점수보다 이것을 먼저 봐야 한다. 미매핑이 많으면 점수가 낮은 것이 아니라 안 보이는 것이다.
 */
export interface CapabilityCoverage {
  total: number;
  mapped: number;
  unmapped: number;
  /** 미매핑 도구 이름의 상위 목록. 프로필에 무엇을 더할지 그대로 알려준다. */
  unmappedTop: Array<{ name: string; count: number }>;
  /** 0~1. mapped / total. */
  ratio: number;
}

/**
 * 이 비율 아래로 덮이면 점수를 내지 않는다.
 *
 * 숫자에 근거가 있지는 않다. 다만 "모르는 호출이 열에 하나를 넘으면 그 화면은 하네스가
 * 아니라 프로필의 빈칸을 보여주는 것"이라는 판단이고, 임계라기보다 침묵하지 않기 위한
 * 장치다. 넘으면 점수 대신 무엇이 안 잡혔는지를 보여준다.
 */
export const MIN_COVERAGE_TO_SCORE = 0.9;

export function measureCoverage(
  resolver: CapabilityResolver,
  calls: ReadonlyArray<{ name: string; command: string | null }>,
  topN = 8,
): CapabilityCoverage {
  const unmatched = new Map<string, number>();
  let mapped = 0;
  for (const c of calls) {
    if (resolver.resolve(c.name, c.command) === null) {
      unmatched.set(c.name, (unmatched.get(c.name) ?? 0) + 1);
    } else {
      mapped += 1;
    }
  }
  const total = calls.length;
  return {
    total,
    mapped,
    unmapped: total - mapped,
    unmappedTop: [...unmatched.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, topN),
    ratio: total === 0 ? 1 : mapped / total,
  };
}

/**
 * Claude Code 프로필.
 *
 * 이 프로필은 능력 층을 넣기 전의 하드코딩과 **정확히 같은 판정**을 내야 한다. 층을 넣으면서
 * 점수가 움직이면 그것은 이식성 개선이 아니라 정의 변경이다. 테스트가 그것을 지킨다.
 */
export const CLAUDE_CODE_PROFILE: HarnessProfile = {
  id: "claude-code",
  label: L("Claude Code", "Claude Code"),
  tools: {
    Glob: "file-find",
    Grep: "content-search",
    Read: "file-read",
    Edit: "file-edit",
    MultiEdit: "file-edit",
    Write: "file-edit",
    NotebookEdit: "file-edit",
    Bash: "shell",
    Agent: "subagent",
    Task: "subagent",
    // 축이 보지 않는 도구도 명시한다. 빼두면 "축과 무관함"과 "모르는 도구"가 한 통에
    // 들어가 커버리지가 프로필의 빈칸을 하네스의 문제처럼 보이게 한다.
    TodoWrite: "other",
    AskUserQuestion: "other",
    Skill: "other",
    ToolSearch: "other",
    StructuredOutput: "other",
    WebFetch: "other",
    WebSearch: "other",
    Artifact: "other",
    ExitPlanMode: "other",
    EnterPlanMode: "other",
    ReportFindings: "other",
    ScheduleWakeup: "other",
    Workflow: "other",
    Monitor: "other",
    TaskOutput: "other",
    TaskStop: "other",
    SendMessage: "other",
  },
  toolPatterns: [
    // 조회 계열을 검색보다 먼저 본다. 순서가 뒤집히면 `qmd get` 이 검색으로 잡힌다.
    { pattern: "qmd__(get|multi_get|status)", capability: "index-fetch" },
    { pattern: "graphify__(graph_stats|list_prs)", capability: "index-fetch" },
    { pattern: "qmd__query", capability: "index-search" },
    { pattern: "graphify__", capability: "index-search" },
    // 그 밖의 MCP 도구. 축이 보지 않지만 아는 호출이다. 반드시 마지막에 둔다.
    { pattern: "^mcp__", capability: "other" },
  ],
  shellCommands: [
    // 셸로 도는 인덱스 검색. 이 줄들이 graphify 사고를 막는 자리다.
    {
      pattern: "\\b(qmd)\\s+(query|search|vsearch)\\b",
      capability: "index-search",
    },
    {
      pattern: "\\b(graphify)\\s+(query|explain|path|affected)\\b",
      capability: "index-search",
    },
    {
      pattern: "\\b(qmd)\\s+(get|multi_get|status)\\b",
      capability: "index-fetch",
    },
    {
      pattern: "\\bgquery\\.py\\s+(stats|god|community)\\b",
      capability: "index-fetch",
    },
  ],
};

export const BUILT_IN_PROFILES: Record<string, HarnessProfile> = {
  "claude-code": CLAUDE_CODE_PROFILE,
};
