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

describe("탐색을 파일 찾기와 내용 찾기로 나눈다", () => {
  it("Grep 은 계측 도구지만 내용 전수 스캔이라 분자다", () => {
    const m = computeSessionMetrics("s", [
      call({ name: "Grep" }),
      call({ name: "mcp__qmd__query" }),
    ]);
    expect(m.axes.indexedRetrieval).toEqual({ num: 1, den: 2 });
  });

  it("Glob 은 파일 찾기의 옳은 대안이라 가점 쪽이다", () => {
    // 초판은 Glob 을 감점으로 뒀고, 그래서 find 를 Glob 으로 바꿔도 점수가 안 올랐다.
    const m = computeSessionMetrics("s", [call({ name: "Glob" })]);
    expect(m.extras.fileFind).toEqual({ num: 1, den: 1 });
    expect(m.axes.indexedRetrieval).toEqual({ num: 0, den: 0 });
  });

  it("bash find 는 같은 분모에서 Glob 과 비교된다", () => {
    const m = computeSessionMetrics("s", [
      bash("find . -name '*.ts'"),
      call({ name: "Glob" }),
    ]);
    expect(m.extras.fileFind).toEqual({ num: 1, den: 2 });
  });

  it("CLI 로 부른 graphify 도 인덱스 검색으로 센다", () => {
    // 이 환경은 graphify 를 CLI 로 쓰는 것이 기본이라 MCP 도구 이름만 세면
    // 실측 1,221건 중 8건만 잡힌다.
    const m = computeSessionMetrics("s", [
      bash(`cd /w/.agent && graphify explain "useSubscribeMutation"`),
      bash(`(cd .agent && graphify query "membership plan")`),
      bash(`grep -rn foo app/`),
    ]);
    expect(m.axes.indexedRetrieval).toEqual({ num: 1, den: 3 });
  });

  it("CLI 로 부른 qmd query 도 센다", () => {
    const m = computeSessionMetrics("s", [
      bash(
        `INDEX_PATH=.agent/qmd/index.sqlite qmd query --collection codebase "결제"`,
      ),
    ]);
    expect(m.axes.indexedRetrieval).toEqual({ num: 0, den: 1 });
  });

  it("CLI 조회·진단 계열은 분모 크레딧을 주지 않는다", () => {
    // qmd status·bench 와 graphify stats 를 반복 호출해 점수를 올리는 경로를 닫는다.
    const m = computeSessionMetrics("s", [
      bash(`INDEX_PATH=.agent/qmd/index.sqlite qmd status`),
      bash(`INDEX_PATH=.agent/qmd/index.sqlite qmd bench`),
      bash(`cd .agent && graphify stats`),
      bash(`python3 .agent/script/gquery.py god`),
    ]);
    expect(m.axes.indexedRetrieval).toEqual({ num: 0, den: 0 });
  });

  it("한 명령이 인덱스 검색과 전수 스캔을 겸하면 둘 다 센다", () => {
    const m = computeSessionMetrics("s", [
      bash(`cd .agent && graphify explain "Foo" && grep -rn Foo app/`),
    ]);
    expect(m.axes.indexedRetrieval).toEqual({ num: 1, den: 2 });
  });

  it("조회 계열은 검색이 아니라 분모 크레딧을 주지 않는다", () => {
    // qmd get 을 반복 호출해 점수를 올리는 경로를 닫는다.
    const m = computeSessionMetrics("s", [
      call({ name: "mcp__qmd__get" }),
      call({ name: "mcp__qmd__status" }),
    ]);
    expect(m.axes.indexedRetrieval).toEqual({ num: 0, den: 0 });
  });
});

describe("근거 확보율", () => {
  it("기존 파일을 안 읽고 고치면 감점이다", () => {
    const m = computeSessionMetrics("s", [
      call({ name: "Edit", file_path: "a.ts" }),
    ]);
    expect(m.extras.groundedEdit).toEqual({ num: 0, den: 1 });
  });

  it("Edit 은 type 필드가 없어도 기존 파일 편집으로 센다", () => {
    // type 은 Write 결과에만 실린다. 그것만 보면 Edit 4,450건이 분모에서 빠진다.
    const m = computeSessionMetrics("s", [
      call({ name: "Edit", file_path: "a.ts", edit_type: null }),
      call({ name: "MultiEdit", file_path: "b.ts", edit_type: null }),
    ]);
    expect(m.extras.groundedEdit.den).toBe(2);
  });

  it("Write 는 type 이 없으면 판정 불가라 분모에서 뺀다", () => {
    const m = computeSessionMetrics("s", [
      call({ name: "Write", file_path: "a.ts", edit_type: null }),
    ]);
    expect(m.extras.groundedEdit.den).toBe(0);
  });

  it("먼저 읽고 고치면 가점이다", () => {
    const m = computeSessionMetrics("s", [
      call({
        name: "Read",
        file_path: "a.ts",
        total_lines: 50,
        num_lines: 50,
        start_line: 1,
      }),
      call({ name: "Edit", file_path: "a.ts" }),
    ]);
    expect(m.extras.groundedEdit).toEqual({ num: 1, den: 1 });
  });

  it("새로 만든 파일은 읽을 것이 없어 분모에서 뺀다", () => {
    const m = computeSessionMetrics("s", [
      call({ name: "Write", file_path: "new.ts", edit_type: "create" }),
    ]);
    expect(m.extras.groundedEdit).toEqual({ num: 0, den: 0 });
  });

  it("문서 편집은 분모에 안 넣는다", () => {
    const m = computeSessionMetrics("s", [
      call({ name: "Edit", file_path: "notes.md" }),
    ]);
    expect(m.extras.groundedEdit.den).toBe(0);
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
