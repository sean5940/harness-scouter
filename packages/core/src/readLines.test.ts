import { describe, expect, it } from "vitest";
import { extractFacts } from "./extract.js";

/**
 * subagent 의 Read 결과에서 줄 정보를 되살리는가.
 *
 * subagent 트랜스크립트에는 `toolUseResult` 가 아예 없다. 파일 정보가 담긴 그 객체가 메인
 * 세션에만 붙어서, Read 결과의 60%(7,805건)가 총 줄 수를 잃고 있었다. 읽기 범위 규율이
 * 실제 읽기의 절반만 보고 있었다는 뜻이다.
 *
 * graphify 를 MCP 이름으로만 세다 CLI 1,220건을 4건으로 본 것과 같은 종류다. 채널 하나를
 * 안 보면 화면은 아무 말도 안 하고 숫자만 조용히 절반이 된다.
 */
function entry(toolUseResult: unknown, content: unknown) {
  return {
    type: "user",
    sessionId: "s1",
    uuid: "u1",
    timestamp: "2026-08-04T00:00:00Z",
    toolUseResult,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content }],
    },
  } as never;
}

const facts = (toolUseResult: unknown, content: unknown, file: string) =>
  extractFacts([entry(toolUseResult, content)], "/x", file);

const numbered = [
  "     1\tconst a = 1;",
  "     2\tconst b = 2;",
  "     3\tconst c = 3;",
  "     4\tconst d = 4;",
].join("\n");

describe("subagent Read 결과", () => {
  it("toolUseResult 가 없어도 줄 정보를 되살린다", () => {
    const out = facts(null, numbered, "/x/subagents/agent-a.jsonl");
    const r = out.toolResults[0];
    expect(r?.numLines).toBe(4);
    expect(r?.startLine).toBe(1);
    // 총 줄 수는 모른다. 끝 줄 번호가 하한이다.
    expect(r?.totalLines).toBe(4);
  });

  it("중간부터 읽은 것도 시작 줄을 살린다", () => {
    const partial = ["   250\tfoo();", "   251\tbar();", "   252\tbaz();"].join(
      "\n",
    );
    const out = facts(null, partial, "/x/subagents/agent-a.jsonl");
    const r = out.toolResults[0];
    expect(r?.startLine).toBe(250);
    expect(r?.totalLines).toBe(252);
    expect(r?.numLines).toBe(3);
  });

  it("배열 content 도 읽는다", () => {
    const out = facts(
      null,
      [{ type: "text", text: numbered }],
      "/x/subagents/agent-a.jsonl",
    );
    expect(out.toolResults[0]?.numLines).toBe(4);
  });

  it("toolUseResult 가 있으면 그것을 그대로 쓴다", () => {
    // 되살리기는 폴백이다. 원본 정보가 있으면 손대지 않는다.
    const out = facts(
      { file: { totalLines: 900, numLines: 50, startLine: 10 } },
      numbered,
      "/x/a.jsonl",
    );
    const r = out.toolResults[0];
    expect(r?.totalLines).toBe(900);
    expect(r?.numLines).toBe(50);
    expect(r?.startLine).toBe(10);
  });
});

describe("Read 가 아닌 결과를 잘못 읽지 않는다", () => {
  it("번호 없는 본문은 무시한다", () => {
    const out = facts(
      null,
      "npm test\n\n  Tests  12 passed\n",
      "/x/subagents/agent-a.jsonl",
    );
    expect(out.toolResults[0]?.totalLines).toBeNull();
  });

  it("번호 붙은 줄이 태반이 아니면 무시한다", () => {
    // bash 출력에 우연히 번호가 섞이는 것을 막는다.
    const mixed = [
      "some output",
      "more output",
      "     1\tfoo",
      "     2\tbar",
      "     3\tbaz",
      "even more",
      "and more",
      "still more",
    ].join("\n");
    const out = facts(null, mixed, "/x/subagents/agent-a.jsonl");
    expect(out.toolResults[0]?.totalLines).toBeNull();
  });

  it("번호가 두 줄뿐이면 무시한다", () => {
    const out = facts(
      null,
      "     1\tfoo\n     2\tbar",
      "/x/subagents/agent-a.jsonl",
    );
    expect(out.toolResults[0]?.totalLines).toBeNull();
  });

  it("빈 본문은 무시한다", () => {
    const out = facts(null, "", "/x/subagents/agent-a.jsonl");
    expect(out.toolResults[0]?.totalLines).toBeNull();
  });
});
