import { describe, expect, it } from "vitest";

import type { ScouterDb, ToolCallRecord } from "../src/db.js";
import { diagnoseExplorationTiming } from "../src/diagnose.js";
import type { Period } from "../src/periods.js";

/**
 * 탐색 적시성 진단의 회귀 테스트.
 *
 * 이 판정은 한 번 틀린 적이 있다. 신호 위치를 "임계가 충족된 시점"이 아니라 "신호를
 * 만들기 시작한 첫 이벤트"에 두어서, 실제로 잰 것이 "필요해지기 전에 불렀나"가 아니라
 * "구간 맨 처음에 불렀나"였다. 그 결함이 before 와 after 의 순서를 뒤집었다.
 */

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

const scan = (pattern: string, extra: Partial<ToolCallRecord> = {}) =>
  call({ name: "Bash", command: `grep -rn "${pattern}" app/`, ...extra });
const index = (extra: Partial<ToolCallRecord> = {}) =>
  call({
    name: "Bash",
    command: `cd .agent && graphify explain "Foo"`,
    ...extra,
  });
const read = (path: string, extra: Partial<ToolCallRecord> = {}) =>
  call({ name: "Read", file_path: path, ...extra });

function stub(calls: ToolCallRecord[]): { db: ScouterDb; period: Period } {
  const db = { toolCallsOf: () => calls } as unknown as ScouterDb;
  const period = { sessionIds: ["s"] } as unknown as Period;
  return { db, period };
}

function timingOf(calls: ToolCallRecord[]) {
  const { db, period } = stub(calls);
  return diagnoseExplorationTiming(db, period);
}

describe("탐색 적시성", () => {
  it("스캔이 임계에 닿기 전에 인덱스를 부르면 신호 전이다", () => {
    const t = timingOf([index(), scan("a"), scan("b"), scan("c")]);
    expect(t.main).toMatchObject({
      episodes: 1,
      before: 1,
      after: 0,
      never: 0,
    });
  });

  it("임계를 넘긴 뒤에 부르면 소모 후다", () => {
    const t = timingOf([scan("a"), scan("b"), scan("c"), index()]);
    expect(t.main).toMatchObject({
      episodes: 1,
      before: 0,
      after: 1,
      never: 0,
    });
  });

  it("두 번째 스캔 뒤에 부른 것은 아직 신호 전이다", () => {
    // 임계는 스캔 3회다. 첫 스캔 위치를 신호로 잡던 결함이면 이 경우가 소모 후로 뒤집힌다.
    const t = timingOf([scan("a"), scan("b"), index(), scan("c")]);
    expect(t.main).toMatchObject({ before: 1, after: 0 });
  });

  it("끝까지 안 부르면 안 부름이다", () => {
    const t = timingOf([scan("a"), scan("b"), scan("c")]);
    expect(t.main).toMatchObject({
      episodes: 1,
      before: 0,
      after: 0,
      never: 1,
    });
  });

  it("같은 검색어를 다시 찾으면 스캔 3회를 안 채워도 임계다", () => {
    const t = timingOf([scan("dup"), scan("dup"), index()]);
    expect(t.main).toMatchObject({ episodes: 1, after: 1 });
  });

  it("임계에 못 닿은 구간은 분모에 넣지 않는다", () => {
    const t = timingOf([scan("a"), scan("b")]);
    expect(t.main.episodes).toBe(0);
  });

  it("코드 파일 3개를 연속으로 읽으면 임계다", () => {
    const t = timingOf([read("a.ts"), read("b.ts"), read("c.ts")]);
    expect(t.main).toMatchObject({ episodes: 1, never: 1 });
  });

  it("같은 파일을 세 번 읽는 것은 임계가 아니다", () => {
    const t = timingOf([read("a.ts"), read("a.ts"), read("a.ts")]);
    expect(t.main.episodes).toBe(0);
  });

  it("문서 읽기는 세지 않는다", () => {
    const t = timingOf([read("a.md"), read("b.md"), read("c.md")]);
    expect(t.main.episodes).toBe(0);
  });

  it("조사 이벤트 사이가 벌어지면 다른 구간으로 끊는다", () => {
    // 사이에 무관한 호출 6개(간격 상한 5 초과)를 넣으면 앞뒤가 갈린다.
    const filler = Array.from({ length: 6 }, () =>
      call({ name: "Bash", command: "git status" }),
    );
    const t = timingOf([
      scan("a"),
      scan("b"),
      scan("c"),
      ...filler,
      scan("d"),
      scan("e"),
      scan("f"),
    ]);
    expect(t.main).toMatchObject({ episodes: 2, never: 2 });
  });

  it("메인과 subagent 를 나눠 센다", () => {
    const t = timingOf([
      scan("a"),
      scan("b"),
      scan("c"),
      scan("x", { agent_id: "w1", is_sidechain: 1 }),
      scan("y", { agent_id: "w1", is_sidechain: 1 }),
      index({ agent_id: "w1", is_sidechain: 1 }),
      scan("z", { agent_id: "w1", is_sidechain: 1 }),
    ]);
    expect(t.main).toMatchObject({ episodes: 1, never: 1 });
    expect(t.subagent).toMatchObject({ episodes: 1, before: 1 });
  });

  it("차단된 호출은 행동으로 세지 않는다", () => {
    const t = timingOf([
      scan("a"),
      scan("b"),
      scan("c", { denial_kind: "permission-rule" }),
    ]);
    expect(t.main.episodes).toBe(0);
  });
});
