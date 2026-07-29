import { describe, expect, it } from "vitest";

import type { ToolCallRecord } from "../src/db.js";
import { computeSessionMetrics } from "../src/metrics.js";

let seq = 0;
function call(partial: Partial<ToolCallRecord>): ToolCallRecord {
  seq += 1;
  return {
    seq,
    name: "Bash",
    command: null,
    file_path: null,
    is_error: null,
    denial_kind: null,
    is_sidechain: 0,
    agent_id: null,
    total_lines: null,
    num_lines: null,
    start_line: null,
    subagent_tool_calls: null,
    subagent_edit_files: null,
    stdout_tail: null,
    ...partial,
  };
}

const bash = (command: string, extra: Partial<ToolCallRecord> = {}) =>
  call({ name: "Bash", command, ...extra });
const edit = (file_path: string, extra: Partial<ToolCallRecord> = {}) =>
  call({ name: "Edit", file_path, ...extra });

describe("차단된 호출은 축에서 뺀다", () => {
  it("훅에 막힌 검색은 축5b 분자에 안 들어간다", () => {
    // 이 프로젝트 자신의 검색 게이트가 막은 호출이 분자의 상당수였다.
    // 넣으면 게이트가 잘 작동할수록 점수가 나빠지는 역설이 생긴다.
    const m = computeSessionMetrics("s", [
      bash("grep -rn foo src/", { denial_kind: "permission-rule" }),
      call({ name: "mcp__qmd__query" }),
    ]);
    expect(m.axes.indexedRetrieval).toEqual({ num: 0, den: 1 });
    expect(m.blockedCalls).toBe(1);
  });

  it("차단된 검증은 공회전으로 세지 않는다", () => {
    // 훅이 복합 명령을 막고 에이전트가 순수 명령으로 재시도하면
    // 그 재시도가 "같은 검증 두 번"으로 잡혔다.
    const m = computeSessionMetrics("s", [
      bash("npx tsc && npx eslint .", { denial_kind: "permission-rule" }),
      bash("npx tsc"),
    ]);
    expect(m.axes.verificationRedundancy).toEqual({ num: 0, den: 1 });
  });
});

describe("축3 커밋 세그먼트는 세션 단위다", () => {
  it("subagent가 고치고 메인이 커밋해도 분모에 들어간다", () => {
    // 에이전트별로 두면 이 커밋이 통째로 분모에서 빠졌다.
    // 실측에서 메인 커밋 438건 중 198건이 그렇게 탈락했다.
    const m = computeSessionMetrics("s", [
      edit("app/a.ts", { agent_id: "w1", is_sidechain: 1 }),
      bash("npx eslint .", { agent_id: "w1", is_sidechain: 1 }),
      bash("git add app/a.ts && git commit -m x"),
    ]);
    expect(m.axes.verificationFreshness).toEqual({ num: 1, den: 1 });
  });

  it("읽기 왕복은 여전히 에이전트별로 센다", () => {
    const m = computeSessionMetrics("s", [
      call({
        name: "Read",
        file_path: "a.ts",
        total_lines: 50,
        num_lines: 50,
        start_line: 1,
        agent_id: "w1",
        is_sidechain: 1,
      }),
      call({
        name: "Read",
        file_path: "a.ts",
        total_lines: 50,
        num_lines: 50,
        start_line: 1,
        agent_id: "w2",
        is_sidechain: 1,
      }),
    ]);
    expect(m.axes.readRevisit).toEqual({ num: 0, den: 2 });
  });
});

describe("축3 분모는 코드 편집만 센다", () => {
  it("bash로 문서를 고친 커밋은 분모에서 뺀다", () => {
    const m = computeSessionMetrics("s", [
      bash("sed -i '' 's/a/b/' docs/design.md"),
      bash("git commit -m docs"),
    ]);
    expect(m.axes.verificationFreshness.den).toBe(0);
    // 계측 우회 자체는 축5a가 잡는다.
    expect(m.axes.instrumentedChannel.num).toBe(1);
  });

  it("bash로 코드를 고친 커밋은 분모에 넣는다", () => {
    const m = computeSessionMetrics("s", [
      bash("sed -i '' 's/a/b/' app/foo.ts"),
      bash("git commit -m fix"),
    ]);
    expect(m.axes.verificationFreshness).toEqual({ num: 0, den: 1 });
  });
});

describe("축5b는 전수 스캔 도구를 분자에 넣는다", () => {
  it("Grep 도구는 계측 채널이지만 인덱스가 아니다", () => {
    const m = computeSessionMetrics("s", [
      call({ name: "Grep" }),
      call({ name: "mcp__qmd__query" }),
    ]);
    expect(m.axes.indexedRetrieval).toEqual({ num: 1, den: 2 });
  });

  it("Glob도 같다", () => {
    const m = computeSessionMetrics("s", [call({ name: "Glob" })]);
    expect(m.axes.indexedRetrieval).toEqual({ num: 1, den: 1 });
  });
});

describe("순서 판정은 저장된 seq가 아니라 스트림 위치로 한다", () => {
  it("seq가 되감겨도 편집 이후 검증을 바로 판정한다", () => {
    // subagent 파일마다 seq가 1부터 다시 매겨져 한 세션 안에서 되감긴다.
    // seq로 비교하면 "편집 이후 검증"이 조용히 뒤집힌다.
    const m = computeSessionMetrics("s", [
      { ...edit("app/a.ts"), seq: 90 },
      { ...bash("npx tsc"), seq: 1 },
      { ...bash("git commit -m x"), seq: 2 },
    ]);
    expect(m.axes.verificationFreshness).toEqual({ num: 1, den: 1 });
  });
});
