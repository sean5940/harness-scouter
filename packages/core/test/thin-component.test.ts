import { describe, expect, it } from "vitest";

import { PERIOD_BUDGET } from "../src/definitions.js";
import { emptyAxes, emptyCapability, emptyExtras } from "../src/metrics.js";
import { emptyEvents, emptyUsage, type Period } from "../src/periods.js";
import { computeStats } from "../src/stats.js";

/**
 * 얇은 구성요소가 두꺼운 것과 같은 무게를 갖지 않는지 본다.
 *
 * `axisScore()` 는 `den === 0` 만 막고 `meanOf` 는 가중치 없이 평균한다. 그래서 제보된
 * 화면에 이런 줄이 나왔다.
 *
 * ```
 * 커밋 전 검증 신선도    0   n=477
 * 검증 공회전 없음     100   n=  3     ← 같은 가중치
 * ```
 *
 * 검증력 50 은 477건짜리 0 과 3건짜리 100 을 반씩 섞은 값이다. 3건에서 나온 100 은
 * 관측이 아니라 잡음인데 화면에서는 구별이 안 된다.
 *
 * 두 세계를 만든다. 얇은 쪽이 있는 세계와 없는 세계에 **똑같은 두꺼운 값**을 넣고,
 * 얇은 쪽이 스탯을 움직이지 못하는지 본다. 움직이면 3건이 477건과 같은 말을 한 것이다.
 */

function periodOf(
  mutate: (axes: ReturnType<typeof emptyAxes>) => void,
): Period {
  const axes = emptyAxes();
  mutate(axes);
  return {
    index: 0,
    sessionIds: ["s1"],
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-02T00:00:00Z",
    axes,
    extras: emptyExtras(),
    events: emptyEvents(),
    usage: emptyUsage(),
    delivery: { num: 0, den: 0 },
    coverage: { observable: 0, offChannel: 0, opaque: 0 },
    capability: emptyCapability(),
    open: false,
  } as Period;
}

const verificationOf = (period: Period) =>
  computeStats(period).find((s) => s.key === "verification");

describe("얇은 분모는 두꺼운 분모와 같은 무게를 갖지 않는다", () => {
  it("제보된 화면: 3건짜리 100 이 477건짜리 0 을 절반으로 끌어올리지 않는다", () => {
    const stat = verificationOf(
      periodOf((a) => {
        a.verificationFreshness = { num: 0, den: 477 };
        // 뒤집힌 축이라 분자가 감점이다. 0/3 이면 공회전 없음 100 이 된다.
        a.verificationRedundancy = { num: 0, den: 3 };
      }),
    );
    expect(stat?.score).toBe(0);
    expect(stat?.scoredCount).toBe(1);
    expect(stat?.scorableCount).toBe(2);
  });

  it("얇은 쪽을 아예 뺀 세계와 같은 값이 나온다", () => {
    // 얇은 것이 있으나 없으나 같아야 한다. 다르면 그것이 무게를 가진 것이다.
    const withThin = verificationOf(
      periodOf((a) => {
        a.verificationFreshness = { num: 0, den: 477 };
        a.verificationRedundancy = { num: 0, den: 3 };
      }),
    );
    const withoutThin = verificationOf(
      periodOf((a) => {
        a.verificationFreshness = { num: 0, den: 477 };
      }),
    );
    expect(withThin?.score).toBe(withoutThin?.score);
  });

  it("두꺼우면 그대로 섞인다", () => {
    // 가드가 "얇으면 뺀다" 이지 "빼고 본다" 가 아니다. 분모가 서면 값이 살아야 한다.
    const stat = verificationOf(
      periodOf((a) => {
        a.verificationFreshness = { num: 0, den: 477 };
        a.verificationRedundancy = { num: 0, den: 400 };
      }),
    );
    expect(stat?.score).toBe(50);
    expect(stat?.scoredCount).toBe(2);
  });

  it("하한은 축이 이미 정해 둔 값이다", () => {
    // 새 숫자를 만들지 않았다는 것을 고정한다. `PERIOD_BUDGET` 이 바뀌면 여기도 따라간다.
    const floor = PERIOD_BUDGET.verificationRedundancy;
    const atFloor = verificationOf(
      periodOf((a) => {
        a.verificationFreshness = { num: 0, den: 477 };
        a.verificationRedundancy = { num: 0, den: floor };
      }),
    );
    const belowFloor = verificationOf(
      periodOf((a) => {
        a.verificationFreshness = { num: 0, den: 477 };
        a.verificationRedundancy = { num: 0, den: floor - 1 };
      }),
    );
    expect(atFloor?.scoredCount).toBe(2);
    expect(belowFloor?.scoredCount).toBe(1);
  });

  it("값을 안 내도 분모는 화면에 남는다", () => {
    // 왜 값이 없는지 말할 수 있어야 한다. 분모까지 지우면 "안 쟀다" 와 "얇다" 가 같아진다.
    const stat = verificationOf(
      periodOf((a) => {
        a.verificationFreshness = { num: 0, den: 477 };
        a.verificationRedundancy = { num: 0, den: 3 };
      }),
    );
    const thin = stat?.components.find(
      (c) => c.key === "verificationRedundancy",
    );
    expect(thin?.value).toBe(null);
    expect(thin?.denominator).toBe(3);
  });
});
