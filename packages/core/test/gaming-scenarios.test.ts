import { describe, expect, it } from "vitest";

import { GAMING_SCENARIOS } from "../src/gate.js";
import { AXIS_ORDER, type AxisKey } from "../src/definitions.js";
import { LANGS } from "../src/i18n.js";
import { axisScore, type SessionMetrics } from "../src/metrics.js";

/**
 * 조작 시나리오의 회귀 테스트.
 *
 * 초판은 역수축 분자를 0으로 만드는 변형을 조작이라고 불렀다. 그건 조작이 아니라
 * 목표 달성이고, 그래서 재던 값이 "완전히 잘하면 점수가 얼마나 오르나"였다.
 * 여기서 지키는 것은 각 시나리오가 활동 불변 경로를 표현하고, 근거를 코드 위치로
 * 남기고, 점수를 실제로 올린다는 것이다.
 */

function metricsWith(axis: AxisKey, num: number, den: number): SessionMetrics {
  const axes = Object.fromEntries(
    AXIS_ORDER.map((k) => [k, { num: 0, den: 0 }]),
  ) as SessionMetrics["axes"];
  axes[axis] = { num, den };
  return {
    sessionId: "s",
    axes,
    coverage: { observable: 0, offChannel: 0, opaque: 0 },
  } as unknown as SessionMetrics;
}

describe("조작 시나리오", () => {
  it("6축 전부에 시나리오가 있다", () => {
    // 시나리오 없는 축은 조작 저항을 무조건 통과로 보고해 게이트가 거짓말을 한다.
    for (const axis of AXIS_ORDER) {
      expect(GAMING_SCENARIOS.some((g) => g.axis === axis)).toBe(true);
    }
  });

  it("모든 시나리오가 불변량과 메커니즘을 코드 위치로 남긴다", () => {
    for (const s of GAMING_SCENARIOS) {
      // 한쪽 언어만 채워도 화면 하나가 빈칸이 된다. 두 면을 다 본다.
      for (const lang of LANGS) {
        expect(s.label[lang].length).toBeGreaterThan(0);
        expect(s.invariant[lang].length).toBeGreaterThan(0);
        expect(s.mechanism[lang].length).toBeGreaterThan(0);
        expect(s.realWorldForm[lang].length).toBeGreaterThan(0);
        expect(s.corpusEvidence[lang].length).toBeGreaterThan(0);
      }
    }
  });

  it("닫은 시나리오는 판정에서 빠지고 기록으로만 남는다", () => {
    // 막은 경로를 계속 미달 근거로 삼으면 고쳐도 게이트가 안 움직여 수정할 이유가 사라진다.
    const closed = GAMING_SCENARIOS.filter((g) => g.closed === true);
    expect(closed.length).toBeGreaterThan(0);
    for (const s of closed) {
      expect(s.corpusEvidence.ko).toMatch(/닫음/);
      expect(s.corpusEvidence.en).toMatch(/Closed/);
    }
  });

  it("축마다 아직 열린 경로가 하나는 있다", () => {
    // 전부 닫혔다고 보고되면 조작 저항 검사가 아무것도 안 보는 상태가 된다.
    for (const axis of AXIS_ORDER) {
      const open = GAMING_SCENARIOS.filter(
        (g) => g.axis === axis && g.closed !== true,
      );
      expect(open.length, `${axis} 에 열린 시나리오 없음`).toBeGreaterThan(0);
    }
  });

  it("모든 시나리오가 점수를 올린다", () => {
    // 내리는 변형은 자해지 조작이 아니다. 부호를 유지하므로 여기서 걸러야 한다.
    for (const s of GAMING_SCENARIOS) {
      const m = metricsWith(s.axis, 40, 100);
      const before = axisScore(s.axis, m.axes[s.axis]);
      s.apply(m);
      const after = axisScore(s.axis, m.axes[s.axis]);
      expect(after).not.toBeNull();
      expect(after as number).toBeGreaterThan(before as number);
    }
  });

  it("어떤 시나리오도 분모를 0으로 만들지 않는다", () => {
    // 분모가 사라지면 점수가 null 이 되어 shift 가 NaN 으로 흐른다.
    for (const s of GAMING_SCENARIOS) {
      const m = metricsWith(s.axis, 40, 100);
      s.apply(m);
      expect(m.axes[s.axis].den).toBeGreaterThan(0);
    }
  });

  it("대상 축 말고 다른 축은 건드리지 않는다", () => {
    // 교차 효과는 shift 산술에 넣지 않는다. 넣으면 구간 경계가 흔들려 대상 축 값까지 바뀐다.
    for (const s of GAMING_SCENARIOS) {
      const m = metricsWith(s.axis, 40, 100);
      for (const axis of AXIS_ORDER) {
        if (axis !== s.axis) m.axes[axis] = { num: 7, den: 13 };
      }
      s.apply(m);
      for (const axis of AXIS_ORDER) {
        if (axis !== s.axis) expect(m.axes[axis]).toEqual({ num: 7, den: 13 });
      }
    }
  });

  it("축마다 시나리오가 여럿이라 첫 하나만 보면 안 된다", () => {
    // find 로 첫 하나만 쓰면 등록 순서가 결론을 바꾼다.
    const counts = new Map<string, number>();
    for (const s of GAMING_SCENARIOS)
      counts.set(s.axis, (counts.get(s.axis) ?? 0) + 1);
    expect([...counts.values()].some((n) => n > 1)).toBe(true);
  });
});
