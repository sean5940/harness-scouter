import { describe, expect, it } from "vitest";

import { runGate } from "../src/gate.js";
import { type AxisKey } from "../src/definitions.js";
import { emptyAxes, emptyExtras, type SessionMetrics } from "../src/metrics.js";
import {
  emptyEvents,
  emptyUsage,
  type SessionForPeriod,
} from "../src/periods.js";

/**
 * 축이 화면을 못 받칠 때, 왜 못 받치는지가 화면에 남는지 본다.
 *
 * 지지 여부를 boolean 으로 접으면 "재봤고 아니었다" 와 "아직 못 쟀다" 가 같은 값이 된다.
 * 그러면 `0/6` 을 본 사람이 여섯 축이 재현에 실패했다고 읽는데, 실제로는 여섯 축을
 * 아직 못 잰 것일 수 있다. 해야 할 일이 정반대다 — 앞은 축을 고쳐야 하고 뒤는 세션을
 * 더 쌓아야 한다.
 *
 * 이 도구의 제1규칙이 재보지 못한 것을 통과로 세지 않는 것인데, 부호만 뒤집어 미달로
 * 세는 것도 같은 잘못이다.
 *
 * 그래서 두 세계를 만든다. 원인이 있는 세계(검사가 실제로 미달)와 없는 세계(미달은
 * 없는데 표본이 얇아 못 잼)에 같은 질문을 하고, 앞에서만 `fail` 이 나오는지 본다.
 */

const HOUR_MS = 3_600_000;

function session(
  index: number,
  counts: Array<[AxisKey, { num: number; den: number }]>,
): SessionForPeriod {
  const axes = emptyAxes();
  for (const [axis, count] of counts) axes[axis] = { ...count };
  const at = new Date(Date.UTC(2026, 0, 1) + index * HOUR_MS).toISOString();
  return {
    metrics: {
      sessionId: `s${String(index).padStart(3, "0")}`,
      axes,
      extras: emptyExtras(),
      coverage: { observable: 0, offChannel: 0, opaque: 0 },
      capability: { total: 0, mapped: 0, unmapped: {} },
      verifierOutcomeUnknown: 0,
      blockedCalls: 0,
    } as SessionMetrics,
    startedAt: at,
    endedAt: at,
    events: emptyEvents(),
    usage: emptyUsage(),
    reachedArtifact: false,
  };
}

const gateOf = (sessions: SessionForPeriod[]) =>
  runGate(
    sessions.map((s) => s.metrics),
    sessions,
    "en",
  );

const supportOf = (gate: ReturnType<typeof gateOf>, axis: AxisKey) =>
  gate.axes.find((a) => a.axis === axis);

/**
 * 구간이 몇 개 안 나오는 얇은 코퍼스. 분모는 예산을 넘겨 미달을 만들지 않는다.
 *
 * split-half 는 구간 안에서 세션을 반으로 갈라 물으므로, 구간 수와 세션 수가 얇으면
 * 판정 자체를 못 한다. 미달이 아니라 계산 불가가 나와야 하는 자리다.
 */
function thinCorpus(): SessionForPeriod[] {
  return Array.from({ length: 8 }, (_, i) =>
    session(i, [["readScope", { num: 8, den: 12 }]]),
  );
}

describe("못 받친 이유를 미달과 판정 불가로 가른다", () => {
  it("지지 여부가 boolean 이 아니라 3값이다", () => {
    const gate = gateOf(thinCorpus());
    for (const axis of gate.axes) {
      expect(["pass", "fail", "not-computable"]).toContain(
        axis.supportsAllTime,
      );
      expect(["pass", "fail", "not-computable"]).toContain(
        axis.supportsPerPeriod,
      );
    }
  });

  it("분모가 아예 없는 축은 미달이 아니라 판정 불가로 남는다", () => {
    // 이 코퍼스는 readScope 에만 값을 넣었다. 나머지 축은 분모가 0 이라 어떤 검사도
    // 성립하지 않는다. 그것은 그 축이 나쁘다는 뜻이 아니라 재본 적이 없다는 뜻이다.
    const gate = gateOf(thinCorpus());
    const idle = supportOf(gate, "verificationFreshness");
    expect(idle?.supportsPerPeriod).not.toBe("pass");
    expect(idle?.checks.some((c) => c.verdict === "not-computable")).toBe(true);
  });

  it("미달이 하나라도 있으면 판정 불가가 그것을 덮지 않는다", () => {
    // 순서가 뒤집히면 진짜 미달이 "아직 모른다" 뒤에 숨는다. 계산 불가 검사가 함께
    // 있어도 미달이 이겨야 한다.
    const gate = gateOf(thinCorpus());
    for (const axis of gate.axes) {
      const hasFail = axis.checks.some((c) => c.verdict === "fail");
      if (hasFail) expect(axis.supportsPerPeriod).toBe("fail");
    }
  });

  it("검사가 전부 통과면 지지도 통과다", () => {
    // 반대 방향을 잠근다. 이 변경이 "아무것도 통과 못 시킨다" 가 되면 안 된다.
    const gate = gateOf(thinCorpus());
    for (const axis of gate.axes) {
      const allPass = axis.checks.every((c) => c.verdict === "pass");
      if (allPass) expect(axis.supportsPerPeriod).toBe("pass");
    }
  });

  it("passed 는 구간별 지지가 통과일 때만 참이다", () => {
    // 기존 소비자가 읽던 boolean 의 뜻이 안 바뀌어야 한다.
    const gate = gateOf(thinCorpus());
    for (const axis of gate.axes) {
      expect(axis.passed).toBe(axis.supportsPerPeriod === "pass");
    }
  });

  it("전수 집계 지지는 split-half 의 판정 불가에 안 걸린다", () => {
    // split-half 는 구간별 화면에만 필요하다. 그것 하나 때문에 전수 집계까지
    // 판정 불가가 되면 화면 둘을 가른 이유가 사라진다.
    const gate = gateOf(thinCorpus());
    for (const axis of gate.axes) {
      const half = axis.checks.find((c) => c.key === "split-half");
      if (half?.verdict !== "not-computable") continue;
      const restUnknown = axis.checks
        .filter(
          (c) => c.key !== "split-half" && c.key !== "variance-components",
        )
        .some((c) => c.verdict === "not-computable");
      const restFailed = axis.checks
        .filter(
          (c) => c.key !== "split-half" && c.key !== "variance-components",
        )
        .some((c) => c.verdict === "fail");
      if (!restUnknown && !restFailed)
        expect(axis.supportsAllTime).toBe("pass");
    }
  });
});
