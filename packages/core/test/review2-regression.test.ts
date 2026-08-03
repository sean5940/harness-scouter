import { describe, expect, it } from "vitest";

import { searchTermOf } from "../src/bash.js";
import type { ToolCallRecord } from "../src/db.js";
import { extractFacts } from "../src/extract.js";
import { computeSessionMetrics } from "../src/metrics.js";
import type { RawEntry } from "../src/types.js";

/**
 * 적대적 검토 2차에서 재현된 결함들의 회귀 테스트.
 *
 * 검토가 지적한 대로 usage·requestId·큐 이벤트를 덮는 테스트가 한 건도 없었다.
 * 값이 조용히 틀어지는 종류라 눈으로는 안 잡힌다.
 */

function assistantEntry(
  requestId: string,
  output: number,
  extra: Partial<RawEntry> = {},
): RawEntry {
  return {
    type: "assistant",
    sessionId: "s",
    requestId,
    timestamp: "2026-08-01T00:00:00Z",
    message: {
      role: "assistant",
      usage: {
        input_tokens: 10,
        output_tokens: output,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
      },
    },
    ...extra,
  };
}

describe("usage는 응답당 마지막 값을 쓴다", () => {
  it("같은 requestId가 여러 줄로 오면 output 최대값을 남긴다", () => {
    // output_tokens는 스트리밍이라 줄마다 커진다. 첫 줄을 채택하면 통째로 과소집계된다.
    const facts = extractFacts(
      [
        assistantEntry("req_1", 100),
        assistantEntry("req_1", 400),
        assistantEntry("req_1", 900),
      ],
      "/p",
      "/p/a.jsonl",
    );
    expect(facts.usages).toHaveLength(1);
    expect(facts.usages[0]?.output).toBe(900);
  });

  it("requestId가 다르면 각각 남긴다", () => {
    const facts = extractFacts(
      [assistantEntry("req_1", 100), assistantEntry("req_2", 200)],
      "/p",
      "/p/a.jsonl",
    );
    expect(facts.usages).toHaveLength(2);
  });
});

describe("자율성 분모는 메인 스레드 턴만 센다", () => {
  it("subagent 턴은 빼고 센다", () => {
    // 넣으면 위임할수록 분모가 커져 자율성이 저절로 오른다.
    const facts = extractFacts(
      [
        assistantEntry("req_1", 10),
        assistantEntry("req_2", 10, { isSidechain: true }),
        assistantEntry("req_3", 10, { isSidechain: true }),
      ],
      "/p",
      "/p/a.jsonl",
    );
    expect(facts.sessions.get("s")?.assistantTurns).toBe(1);
  });
});

describe("중단 표식은 정확 일치로 판정한다", () => {
  function userText(text: string): RawEntry {
    return {
      type: "user",
      sessionId: "s",
      timestamp: "2026-08-01T00:00:00Z",
      message: { role: "user", content: [{ type: "text", text }] as never },
    };
  }

  it("정확한 표식은 중단으로 센다", () => {
    const facts = extractFacts(
      [userText("[Request interrupted by user]")],
      "/p",
      "/p/a.jsonl",
    );
    expect(
      facts.sessionEvents.filter((e) => e.kind === "interrupt"),
    ).toHaveLength(1);
  });

  it("도구용 변형도 센다", () => {
    const facts = extractFacts(
      [userText("[Request interrupted by user for tool use]")],
      "/p",
      "/p/a.jsonl",
    );
    expect(
      facts.sessionEvents.filter((e) => e.kind === "interrupt"),
    ).toHaveLength(1);
  });

  it("표식을 인용한 지시문은 중단이 아니다", () => {
    const facts = extractFacts(
      [
        userText(
          "로그에서 [Request interrupted by user] 를 세는 코드를 고쳐줘",
        ),
      ],
      "/p",
      "/p/a.jsonl",
    );
    expect(
      facts.sessionEvents.filter((e) => e.kind === "interrupt"),
    ).toHaveLength(0);
  });
});

describe("취소된 큐 입력은 개입이 아니다", () => {
  function queueOp(operation: string): RawEntry {
    return {
      type: "queue-operation",
      sessionId: "s",
      operation,
      timestamp: "2026-08-01T00:00:00Z",
    };
  }

  it("remove로 끝난 enqueue는 개입에서 빠진다", () => {
    // 큐에서 지운 입력은 모델에 전달되지 않는다.
    const facts = extractFacts(
      [
        {
          ...assistantEntry("req_1", 10),
          message: { role: "assistant", stop_reason: "tool_use" },
        },
        queueOp("enqueue"),
        queueOp("remove"),
      ],
      "/p",
      "/p/a.jsonl",
    );
    const kinds = facts.sessionEvents.map((e) => e.kind);
    expect(kinds).toContain("queue_removed");
    expect(kinds).not.toContain("queue_enqueue_midflight");
  });

  it("전달된 enqueue는 개입으로 남는다", () => {
    const facts = extractFacts(
      [
        {
          ...assistantEntry("req_1", 10),
          message: { role: "assistant", stop_reason: "tool_use" },
        },
        queueOp("enqueue"),
        queueOp("dequeue"),
      ],
      "/p",
      "/p/a.jsonl",
    );
    expect(facts.sessionEvents.map((e) => e.kind)).toContain(
      "queue_enqueue_midflight",
    );
  });
});

describe("검색어 추출은 따옴표 묶음을 보존한다", () => {
  it("여러 단어 패턴이 잘리지 않는다", () => {
    expect(searchTermOf('grep -rn "읽기 전용" app/')).not.toBe(
      searchTermOf('grep -rn "읽기전용 금지" app/'),
    );
  });

  it("교대 패턴이 앞 조각으로 뭉치지 않는다", () => {
    expect(searchTermOf("grep -rn 'alpha|beta' src/")).not.toBe(
      searchTermOf("grep -rn 'alpha|gamma' src/"),
    );
  });

  it("find glob은 탐색 루트와 짝지어 구분한다", () => {
    expect(searchTermOf('find .agent -name "*.md"')).not.toBe(
      searchTermOf('find app -name "*.md"'),
    );
  });

  it("값을 받는 옵션 뒤 토큰을 패턴으로 오인하지 않는다", () => {
    expect(searchTermOf('grep -rn --include "*.ts" needle src/')).toBe(
      "grep:needle",
    );
  });
});

describe("재작업 체크포인트는 에이전트별이다", () => {
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

  it("다른 에이전트의 검증은 내 편집의 체크포인트가 아니다", () => {
    const m = computeSessionMetrics("s", [
      call({ name: "Edit", file_path: "a.ts" }),
      call({
        name: "Bash",
        command: "npx tsc",
        agent_id: "w1",
        is_sidechain: 1,
      }),
      call({ name: "Edit", file_path: "a.ts" }),
    ]);
    expect(m.extras.rework.num).toBe(0);
  });

  it("같은 에이전트의 검증은 체크포인트가 된다", () => {
    const m = computeSessionMetrics("s", [
      call({ name: "Edit", file_path: "a.ts" }),
      call({ name: "Bash", command: "npx tsc" }),
      call({ name: "Edit", file_path: "a.ts" }),
    ]);
    expect(m.extras.rework.num).toBe(1);
  });
});
