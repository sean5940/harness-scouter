import { describe, expect, it } from "vitest";

import { computeSessionMetrics } from "../src/metrics.js";
import type { ToolCallRecord } from "../src/db.js";

/**
 * 검증이 고친 것을 덮었는지, 아는 답이 있는 세계로 확인한다.
 *
 * 원인이 있는 세계(무관한 대상에만 검증)와 없는 세계(전체 검증·겹치는 대상)를 따로
 * 만들고 앞에서만 신선도를 잃는지 본다. 실측 숫자가 좋아지는 것은 검증이 아니다.
 */

let seq = 0;
function call(over: Partial<ToolCallRecord>): ToolCallRecord {
  seq += 1;
  return {
    seq,
    name: "Bash",
    command: null,
    file_path: null,
    is_error: 0,
    denial_kind: null,
    is_sidechain: 0,
    agent_id: null,
    total_lines: null,
    num_lines: null,
    start_line: null,
    edit_type: null,
    subagent_tool_calls: null,
    subagent_edit_files: null,
    stdout_tail: "ok",
    ...over,
  } as unknown as ToolCallRecord;
}

/** 코드를 고치고, 주어진 명령으로 검증하고, 커밋하는 세션. */
function freshnessOf(verifier: string, editPath = "app/screens/a.ts") {
  seq = 0;
  const calls = [
    call({ name: "Edit", file_path: editPath, edit_type: "update" }),
    call({ name: "Bash", command: verifier }),
    call({ name: "Bash", command: "git commit -m x" }),
  ];
  return computeSessionMetrics("s", calls).axes.verificationFreshness;
}

describe("고친 것을 안 덮는 검증은 신선도의 근거가 아니다", () => {
  it("프로젝트 전체 검증은 무엇을 고쳤든 덮는다", () => {
    expect(freshnessOf("npx tsc --noEmit")).toEqual({ num: 1, den: 1 });
    expect(freshnessOf("npm run typecheck")).toEqual({ num: 1, den: 1 });
    expect(freshnessOf("npx vitest run")).toEqual({ num: 1, den: 1 });
  });

  it("고친 파일을 겨눈 검증은 덮는다", () => {
    expect(freshnessOf("npx eslint app/screens/a.ts")).toEqual({
      num: 1,
      den: 1,
    });
    expect(freshnessOf("npx eslint app/screens")).toEqual({ num: 1, den: 1 });
  });

  it("무관한 대상만 겨눈 검증은 덮지 않는다", () => {
    // 게이트가 지목한 조작 형태다. 검증을 돌리긴 했지만 커밋된 트리는 안 봤다.
    const got = freshnessOf("npx vitest run test/trivial.test.ts");
    expect(got.den).toBe(1);
    expect(got.num).toBe(0);
  });

  it("덮지 않는 검증 뒤에 전체 검증이 오면 덮는다", () => {
    seq = 0;
    const calls = [
      call({ name: "Edit", file_path: "app/a.ts", edit_type: "update" }),
      call({ name: "Bash", command: "npx vitest run test/trivial.test.ts" }),
      call({ name: "Bash", command: "npx tsc --noEmit" }),
      call({ name: "Bash", command: "git commit -m x" }),
    ];
    expect(
      computeSessionMetrics("s", calls).axes.verificationFreshness,
    ).toEqual({ num: 1, den: 1 });
  });

  it("리다이렉트 대상을 검증 대상으로 오해하지 않는다", () => {
    // `> /tmp/out.txt` 를 대상으로 세면 정상적인 전체 검증이 신선도를 잃는다.
    expect(freshnessOf("npx tsc --noEmit > /tmp/out.txt")).toEqual({
      num: 1,
      den: 1,
    });
  });

  it("검증 자체가 없으면 예전처럼 미달이다", () => {
    const got = freshnessOf("echo hi");
    expect(got).toEqual({ num: 0, den: 1 });
  });

  it("같은 저장소로 옮겨 돌린 검증은 덮는다", () => {
    // 편집은 절대경로로 들어오고 명령은 틸데를 쓴다. 틸데를 안 떼면 같은 저장소인데도
    // 하나도 안 맞아 정상 검증이 통째로 신선도를 잃는다.
    expect(
      freshnessOf(
        "cd ~/Source/rn-preview && npx vitest run",
        "/Users/me/Source/rn-preview/src/a.ts",
      ),
    ).toEqual({ num: 1, den: 1 });
  });

  it("맨 파일이름으로 꼬리를 맞추지 않는다", () => {
    // 대상 `util.ts` 가 아무 디렉토리의 `util.ts` 에나 붙으면, 안 본 파일을 덮은
    // 것으로 셀 수 있다. 구분자를 낀 대상만 꼬리 일치를 쓴다.
    const got = freshnessOf("npx eslint util.ts", "app/deep/util.ts");
    expect(got).toEqual({ num: 0, den: 1 });
  });

  it("구분자를 낀 상대경로는 그대로 덮는다", () => {
    // 편집은 절대경로, 명령은 저장소 기준 상대경로라 이 경로가 정상 동작이다.
    expect(
      freshnessOf(
        "npx eslint app/deep/util.ts",
        "/Users/me/proj/app/deep/util.ts",
      ),
    ).toEqual({ num: 1, den: 1 });
  });

  it("다른 저장소로 옮겨 돌린 검증은 덮지 않는다", () => {
    const got = freshnessOf(
      "cd ~/Source/rn-preview && npx vitest run",
      "/Users/me/Source/soomgo-mobile-app/app/a.ts",
    );
    expect(got).toEqual({ num: 0, den: 1 });
  });
});

/** 지정한 출력으로 검증을 돌리고 커밋하는 세션. */
function freshnessWithOutput(stdout: string | null) {
  seq = 0;
  const calls = [
    call({ name: "Edit", file_path: "app/a.ts", edit_type: "update" }),
    call({ name: "Bash", command: "npx tsc --noEmit", stdout_tail: stdout }),
    call({ name: "Bash", command: "git commit -m x" }),
  ];
  return computeSessionMetrics("s", calls).axes.verificationFreshness;
}

describe("실패한 검증은 신선도의 근거가 아니다", () => {
  it("에러를 낸 검증 뒤의 커밋은 신선하지 않다", () => {
    expect(freshnessWithOutput("src/a.ts(3,5): error TS2345: ...")).toEqual({
      num: 0,
      den: 1,
    });
  });

  it("통과한 검증은 그대로 신선하다", () => {
    expect(freshnessWithOutput("EXIT=0")).toEqual({ num: 1, den: 1 });
  });

  it("성패를 못 가린 검증은 그대로 신선하다", () => {
    // 조용히 통과하는 tsc 는 출력이 아예 없다. 이걸 실패로 보면 정상 검증이 통째로
    // 신선도를 잃는다. 틀리는 방향을 관대한 쪽에 둔다.
    expect(freshnessWithOutput(null)).toEqual({ num: 1, den: 1 });
    expect(freshnessWithOutput("")).toEqual({ num: 1, den: 1 });
    expect(freshnessWithOutput("some unrelated output")).toEqual({
      num: 1,
      den: 1,
    });
  });

  it("실패한 검증 뒤에 고치고 통과시키면 신선하다", () => {
    seq = 0;
    const calls = [
      call({ name: "Edit", file_path: "app/a.ts", edit_type: "update" }),
      call({
        name: "Bash",
        command: "npx tsc --noEmit",
        stdout_tail: "error TS2345: ...",
      }),
      call({ name: "Edit", file_path: "app/a.ts", edit_type: "update" }),
      call({
        name: "Bash",
        command: "npx tsc --noEmit",
        stdout_tail: "EXIT=0",
      }),
      call({ name: "Bash", command: "git commit -m x" }),
    ];
    expect(
      computeSessionMetrics("s", calls).axes.verificationFreshness,
    ).toEqual({ num: 1, den: 1 });
  });
});
