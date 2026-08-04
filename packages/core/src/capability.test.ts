import { describe, expect, it } from "vitest";
import {
  availableCapabilities,
  AXIS_REQUIRES,
  axisMeasurable,
  CLAUDE_CODE_PROFILE,
  createResolver,
  measureCoverage,
  MIN_COVERAGE_TO_SCORE,
  type Capability,
  type HarnessProfile,
} from "./capability.js";
import { L } from "./i18n.js";
import {
  CONTENT_SCAN_TOOLS,
  FILE_FIND_TOOLS,
  isIndexedSearchTool,
} from "./definitions.js";

const resolver = createResolver(CLAUDE_CODE_PROFILE);
const capOf = (
  name: string,
  command: string | null = null,
): Capability | null => resolver.resolve(name, command)?.capability ?? null;

describe("Claude Code 프로필은 기존 하드코딩과 같은 판정을 낸다", () => {
  // 능력 층을 넣으면서 점수가 움직이면 그것은 이식성 개선이 아니라 정의 변경이다.
  it("파일 찾기 도구가 일치한다", () => {
    for (const name of FILE_FIND_TOOLS) {
      expect(capOf(name)).toBe("file-find");
    }
  });

  it("내용 스캔 도구가 일치한다", () => {
    for (const name of CONTENT_SCAN_TOOLS) {
      expect(capOf(name)).toBe("content-search");
    }
  });

  it("인덱스 검색으로 인정하던 이름이 그대로 index-search 다", () => {
    const searchNames = [
      "mcp__qmd__query",
      "mcp__graphify__query_graph",
      "mcp__graphify__get_node",
    ];
    for (const name of searchNames) {
      expect(isIndexedSearchTool(name)).toBe(true);
      expect(capOf(name)).toBe("index-search");
    }
  });

  it("조회 계열은 검색이 아니다", () => {
    const fetchNames = [
      "mcp__qmd__get",
      "mcp__qmd__multi_get",
      "mcp__qmd__status",
      "mcp__graphify__graph_stats",
    ];
    for (const name of fetchNames) {
      expect(isIndexedSearchTool(name)).toBe(false);
      expect(capOf(name)).toBe("index-fetch");
    }
  });
});

describe("셸 안의 CLI 를 본다", () => {
  // graphify 사고의 재발 방지. 도구로 부르든 셸로 부르든 같은 일을 한 것이다.
  it("qmd·graphify CLI 검색을 index-search 로 잡는다", () => {
    expect(capOf("Bash", "qmd query 'foo'")).toBe("index-search");
    expect(capOf("Bash", "(cd .agent && graphify explain useAuth)")).toBe(
      "index-search",
    );
    expect(capOf("Bash", "graphify path A B")).toBe("index-search");
  });

  it("CLI 조회 계열은 index-fetch 다", () => {
    expect(capOf("Bash", "qmd get notes/foo.md")).toBe("index-fetch");
    expect(capOf("Bash", "gquery.py stats")).toBe("index-fetch");
  });

  it("그 밖의 셸은 shell 로 남는다", () => {
    expect(capOf("Bash", "npm test")).toBe("shell");
    expect(capOf("Bash", "git status")).toBe("shell");
  });

  it("command 가 없으면 이름만으로 shell 이다", () => {
    expect(capOf("Bash", null)).toBe("shell");
  });

  it("어느 규칙이 잡았는지 남긴다", () => {
    const m = resolver.resolve("Bash", "qmd query 'foo'");
    expect(m?.via).toBe("shellCommand");
    expect(m?.rule).toContain("qmd");
  });
});

describe("미매핑 계측", () => {
  // 이 파일의 진짜 목적. 매핑표는 언제든 낡으므로 낡았을 때 소리가 나야 한다.
  it("모르는 도구를 세고 상위를 낸다", () => {
    const calls = [
      { name: "Read", command: null },
      { name: "cursor_edit_file", command: null },
      { name: "cursor_edit_file", command: null },
      { name: "aider_add", command: null },
    ];
    const c = measureCoverage(resolver, calls);
    expect(c.total).toBe(4);
    expect(c.mapped).toBe(1);
    expect(c.unmapped).toBe(3);
    expect(c.unmappedTop[0]).toEqual({ name: "cursor_edit_file", count: 2 });
    expect(c.ratio).toBeCloseTo(0.25);
  });

  it("전부 알면 1 이다", () => {
    const calls = [
      { name: "Read", command: null },
      { name: "Bash", command: "npm test" },
    ];
    expect(measureCoverage(resolver, calls).ratio).toBe(1);
  });

  it("호출이 없으면 1 로 본다", () => {
    expect(measureCoverage(resolver, []).ratio).toBe(1);
  });

  it("다른 하네스는 임계 아래로 떨어진다", () => {
    // 이름이 다른 하네스를 그대로 재면 점수가 아니라 이 사실이 나와야 한다.
    const cursorish = Array.from({ length: 10 }, () => ({
      name: "read_file",
      command: null,
    }));
    const c = measureCoverage(resolver, cursorish);
    expect(c.ratio).toBeLessThan(MIN_COVERAGE_TO_SCORE);
    expect(c.unmappedTop[0]?.name).toBe("read_file");
  });
});

describe("프로필 우선순위", () => {
  it("정확 일치가 패턴보다 먼저다", () => {
    expect(resolver.resolve("Read", null)?.via).toBe("tool");
  });

  it("조회 패턴이 검색 패턴보다 먼저다", () => {
    // 순서가 뒤집히면 `qmd get` 이 검색으로 잡혀 분모 크레딧이 새어 나간다.
    expect(capOf("mcp__qmd__get")).toBe("index-fetch");
  });
});

describe("능력이 없으면 0 이 아니라 판정 불가", () => {
  // 이 절이 이 파일의 두 번째 목적이다. 이름 대응만으로는 "없어서 0"과 "안 써서 0"이
  // 구별되지 않아 남의 하네스를 재는 순간 거짓말이 된다.
  it("Claude Code 는 네 축을 모두 잰다", () => {
    const have = availableCapabilities(CLAUDE_CODE_PROFILE);
    for (const axis of Object.keys(AXIS_REQUIRES)) {
      expect(axisMeasurable(axis, have)).toBe(true);
    }
  });

  it("인덱스 도구가 없으면 인덱스 축을 재지 않는다", () => {
    const noIndex: HarnessProfile = {
      ...CLAUDE_CODE_PROFILE,
      toolPatterns: [],
      shellCommands: [],
    };
    const have = availableCapabilities(noIndex);
    expect(have.has("index-search")).toBe(false);
    expect(axisMeasurable("indexedRetrieval", have)).toBe(false);
    // 나머지 축은 그대로 잰다. 능력 하나가 빠졌다고 전부 못 재는 것이 아니다.
    expect(axisMeasurable("readScope", have)).toBe(true);
  });

  it("셸만 있는 하네스는 계측 채널 축을 재지 않는다", () => {
    const shellOnly: HarnessProfile = {
      id: "shell-only",
      label: L("셸 전용", "Shell only"),
      tools: { run: "shell" },
      toolPatterns: [],
      shellCommands: [],
    };
    const have = availableCapabilities(shellOnly);
    expect(axisMeasurable("instrumentedChannel", have)).toBe(false);
    expect(axisMeasurable("readScope", have)).toBe(false);
  });

  it("선언이 있으면 매핑보다 선언을 믿는다", () => {
    // 도구는 있는데 환경 때문에 못 쓰는 경우가 있다. 그때 직접 적는다.
    const declared: HarnessProfile = {
      ...CLAUDE_CODE_PROFILE,
      declaredCapabilities: ["file-read", "file-edit", "shell"],
    };
    const have = availableCapabilities(declared);
    expect(axisMeasurable("instrumentedChannel", have)).toBe(true);
    expect(axisMeasurable("indexedRetrieval", have)).toBe(false);
  });

  it("other 는 능력으로 세지 않는다", () => {
    // 축이 보지 않는 도구라 있어도 축을 성립시키지 못한다.
    const onlyOther: HarnessProfile = {
      id: "x",
      label: L("x", "x"),
      tools: { TodoWrite: "other" },
      toolPatterns: [],
      shellCommands: [],
    };
    expect(availableCapabilities(onlyOther).size).toBe(0);
  });
});
