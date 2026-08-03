import { describe, expect, it } from "vitest";

import type { ToolCallRecord } from "../src/db.js";
import { axisScore, computeSessionMetrics } from "../src/metrics.js";

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
    edit_type: null,
    subagent_tool_calls: null,
    subagent_edit_files: null,
    stdout_tail: null,
    ...partial,
  };
}

function read(
  path: string,
  opts: Partial<ToolCallRecord> = {},
): ToolCallRecord {
  return call({
    name: "Read",
    file_path: path,
    total_lines: 100,
    num_lines: 100,
    start_line: 1,
    ...opts,
  });
}

function edit(path: string): ToolCallRecord {
  return call({ name: "Edit", file_path: path });
}

function bash(
  command: string,
  opts: Partial<ToolCallRecord> = {},
): ToolCallRecord {
  return call({ name: "Bash", command, ...opts });
}

describe("축2 읽기 왕복 절제", () => {
  it("같은 파일을 다시 읽으면 왕복으로 센다", () => {
    const m = computeSessionMetrics("s", [read("a.ts"), read("a.ts")]);
    expect(m.axes.readRevisit).toEqual({ num: 1, den: 2 });
  });

  it("편집한 뒤 다시 읽는 것은 정당한 재확인이라 빼준다", () => {
    const m = computeSessionMetrics("s", [
      read("a.ts"),
      edit("a.ts"),
      read("a.ts"),
    ]);
    expect(m.axes.readRevisit).toEqual({ num: 0, den: 2 });
  });

  it("에이전트가 다르면 왕복이 아니다", () => {
    // 병렬 subagent는 서로의 컨텍스트를 볼 수 없으므로 각자 한 번씩 읽은 것이다.
    const m = computeSessionMetrics("s", [
      read("a.ts", { agent_id: "w1", is_sidechain: 1 }),
      read("a.ts", { agent_id: "w2", is_sidechain: 1 }),
    ]);
    expect(m.axes.readRevisit).toEqual({ num: 0, den: 2 });
  });
});

describe("축3 검증 신선도", () => {
  it("마지막 편집 뒤에 검증이 돌면 신선하다", () => {
    const m = computeSessionMetrics("s", [
      edit("a.ts"),
      bash("npx tsc --noEmit"),
      bash("git commit -m x"),
    ]);
    expect(m.axes.verificationFreshness).toEqual({ num: 1, den: 1 });
  });

  it("검증 뒤에 또 고치고 커밋하면 낡았다", () => {
    // "검증을 돌렸는가"로 재면 이 경우가 통과한다. 커밋된 최종 상태는 통과한 적이 없다.
    const m = computeSessionMetrics("s", [
      edit("a.ts"),
      bash("npx tsc --noEmit"),
      edit("a.ts"),
      bash("git commit -m x"),
    ]);
    expect(m.axes.verificationFreshness).toEqual({ num: 0, den: 1 });
  });

  it("코드 편집이 없는 커밋은 분모에서 뺀다", () => {
    const m = computeSessionMetrics("s", [
      edit("README.md"),
      bash("git commit -m docs"),
    ]);
    expect(m.axes.verificationFreshness.den).toBe(0);
  });

  it("amend는 분모에서 뺀다", () => {
    const m = computeSessionMetrics("s", [
      edit("a.ts"),
      bash("git commit --amend --no-edit"),
    ]);
    expect(m.axes.verificationFreshness.den).toBe(0);
  });
});

describe("축4 검증 공회전 절제", () => {
  it("편집 없이 같은 검증을 반복하면 공회전이다", () => {
    const m = computeSessionMetrics("s", [bash("npx tsc"), bash("npx tsc")]);
    expect(m.axes.verificationRedundancy).toEqual({ num: 1, den: 2 });
  });

  it("사이에 편집이 있으면 공회전이 아니다", () => {
    const m = computeSessionMetrics("s", [
      bash("npx tsc"),
      edit("a.ts"),
      bash("npx tsc"),
    ]);
    expect(m.axes.verificationRedundancy).toEqual({ num: 0, den: 2 });
  });

  it("복합 호출은 1회 호출 2종으로 센다", () => {
    const m = computeSessionMetrics("s", [bash("npx tsc && npx eslint .")]);
    expect(m.axes.verificationRedundancy).toEqual({ num: 0, den: 2 });
  });
});

describe("축5a 계측 채널 준수", () => {
  it("bash 소스 읽기는 위반이고 Read는 분모에만 든다", () => {
    const m = computeSessionMetrics("s", [
      read("a.ts"),
      bash("sed -n '1,5p' b.ts"),
    ]);
    expect(m.axes.instrumentedChannel).toEqual({ num: 1, den: 1 });
    expect(m.coverage).toEqual({ observable: 1, offChannel: 1, opaque: 0 });
  });

  it("subagent 기록이 있으면 집계치를 더하지 않는다", () => {
    // 트랜스크립트를 직접 세면서 toolStats도 더하면 같은 활동을 두 번 센다.
    const m = computeSessionMetrics("s", [
      call({ name: "Agent", subagent_tool_calls: 30, subagent_edit_files: 5 }),
      edit("a.ts"),
      read("b.ts", { agent_id: "w1", is_sidechain: 1 }),
    ]);
    expect(m.coverage.opaque).toBe(0);
  });

  it("subagent 기록이 없으면 집계치로 근사한다", () => {
    const m = computeSessionMetrics("s", [
      call({ name: "Agent", subagent_tool_calls: 30, subagent_edit_files: 5 }),
    ]);
    expect(m.coverage.opaque).toBe(30);
    expect(m.axes.instrumentedChannel.den).toBe(5);
  });
});

describe("축 점수 방향", () => {
  it("역수축은 뒤집어 높을수록 좋게 만든다", () => {
    expect(axisScore("readRevisit", { num: 1, den: 4 })).toBe(0.75);
    expect(axisScore("readScope", { num: 1, den: 4 })).toBe(0.25);
  });

  it("분모가 없으면 점수가 없다", () => {
    expect(axisScore("readScope", { num: 0, den: 0 })).toBeNull();
  });
});
