import { describe, expect, it } from "vitest";

import type { ToolCallRecord } from "../src/db.js";
import {
  classifyWorkType,
  stratumSizes,
  summarizeWorkload,
  WORK_TYPE_VARIANTS,
  type WorkType,
} from "../src/worktype.js";

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

const read = (path: string): ToolCallRecord =>
  call({ name: "Read", file_path: path, total_lines: 50, num_lines: 50 });
const edit = (path: string): ToolCallRecord =>
  call({ name: "Edit", file_path: path });
const write = (path: string, editType: string): ToolCallRecord =>
  call({ name: "Write", file_path: path, edit_type: editType });
const bash = (command: string): ToolCallRecord => call({ command });

/** 호출 목록을 유형까지 한 번에. 판정 순서를 보는 테스트라 중간값은 안 본다. */
const typeOf = (calls: ToolCallRecord[]): WorkType =>
  classifyWorkType(summarizeWorkload(calls));

describe("작업 유형 분류", () => {
  it("아무것도 안 고치고 읽기만 하면 조사다", () => {
    expect(typeOf([read("a.ts"), read("b.ts"), bash("rg foo")])).toBe(
      "explore",
    );
  });

  it("편집 없이 검증·커밋만 하면 검증·운영이다", () => {
    expect(typeOf([bash("npx tsc --noEmit"), bash("git commit -m x")])).toBe(
      "verify",
    );
  });

  it("검증이 하한에 못 미치면 조사로 남는다", () => {
    // 조사 도중 한 번 돌려본 것을 운영 세션이라 부르면 층이 조사 쪽에서 새어 나간다.
    expect(typeOf([read("a.ts"), bash("npx tsc --noEmit")])).toBe("explore");
  });

  it("코드가 아닌 것만 고치면 문서·설정이다", () => {
    expect(typeOf([edit("README.md"), edit("docs/x.md")])).toBe("docs");
  });

  it("새로 만든 코드 파일 비중이 높으면 신규 구현이다", () => {
    expect(
      typeOf([write("a.ts", "create"), write("b.ts", "create"), edit("c.ts")]),
    ).toBe("build");
  });

  it("기존 코드 파일 위주로 고치면 기존 수정이다", () => {
    expect(
      typeOf([
        edit("a.ts"),
        edit("b.ts"),
        edit("c.ts"),
        write("d.ts", "create"),
      ]),
    ).toBe("modify");
  });

  it("코드를 한 줄이라도 고치면 문서가 섞여도 문서 세션이 아니다", () => {
    // 문서 판정이 "코드 편집 0"이라 순서가 뒤집히면 리팩터링이 문서로 샌다.
    expect(
      typeOf([edit("README.md"), edit("README.ja.md"), edit("a.ts")]),
    ).toBe("modify");
  });

  it("막힌 호출은 하지 않은 일이라 세지 않는다", () => {
    const blocked = call({
      name: "Edit",
      file_path: "a.ts",
      denial_kind: "hook",
    });
    expect(typeOf([read("a.ts"), blocked])).toBe("explore");
  });

  it("bash 로 쓴 파일도 편집으로 센다", () => {
    // 계측 채널을 우회한 편집을 조사 세션으로 분류하면 층이 통째로 어긋난다.
    expect(typeOf([bash("cat > a.ts <<'EOF'\nx\nEOF")])).toBe("modify");
  });
});

describe("집계", () => {
  it("한 번 걸어 유형 판정에 필요한 것을 전부 낸다", () => {
    const counts = summarizeWorkload([
      read("a.ts"),
      bash("rg foo"),
      write("b.ts", "create"),
      edit("c.ts"),
      edit("notes.md"),
      bash("npx tsc --noEmit"),
      bash("git commit -m x"),
    ]);
    expect(counts.codeEdits).toBe(2);
    expect(counts.docEdits).toBe(1);
    expect(counts.createdCodeFiles).toBe(1);
    expect(counts.reads).toBe(1);
    expect(counts.searches).toBe(1);
    expect(counts.verifierRuns).toBeGreaterThan(0);
    expect(counts.commits).toBe(1);
  });

  it("같은 집계를 다시 분류해도 같은 유형이다", () => {
    // 변형 다섯 개를 돌리려고 집계와 분류를 갈랐다. 분류가 집계를 건드리면 두 번째
    // 변형부터 다른 답이 나온다.
    const counts = summarizeWorkload([edit("a.ts"), edit("b.ts")]);
    const first = WORK_TYPE_VARIANTS.map((v) => classifyWorkType(counts, v));
    const second = WORK_TYPE_VARIANTS.map((v) => classifyWorkType(counts, v));
    expect(first).toEqual(second);
  });
});

describe("층 크기", () => {
  it("들어간 층만 센다", () => {
    const sizes = stratumSizes(["explore", "explore", "modify"]);
    expect(sizes.explore).toBe(2);
    expect(sizes.modify).toBe(1);
    expect(sizes.docs).toBe(0);
  });
});
