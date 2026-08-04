import { describe, expect, it } from "vitest";
import { emptyAxes, emptyExtras } from "./metrics.js";
import { emptyEvents, emptyUsage, type Period } from "./periods.js";
import { computeStats } from "./stats.js";

/**
 * 널 하네스 바닥.
 *
 * 조작 시나리오는 "행동은 그대로인데 계산만 좋아지는가"를 묻는다. 그 대칭이 빠져 있었다.
 * **아무 일도 안 한 하네스가 높은 점수를 받는가**는 아무도 안 물었고, 실제로 받는다.
 *
 * 원인은 평균이 값 없는 구성요소를 빼고 생존자로 재평균하는 데 있다. 빼는 것 자체는
 * 옳지만(없는 일을 못했다고 셀 수는 없다), 셋 중 둘이 빠지면 남은 하나가 스탯 전체가
 * 되는데 화면은 여전히 셋을 재는 것처럼 보인다.
 *
 * 여기서 하는 일은 점수를 억지로 낮추는 것이 아니라 **몇 개로 낸 점수인지가 밖으로
 * 나오는지**를 고정하는 것이다. 판단은 읽는 사람이 한다.
 */
function periodOf(
  mutate: (axes: ReturnType<typeof emptyAxes>) => void,
): Period {
  const axes = emptyAxes();
  mutate(axes);
  return {
    index: 0,
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-02T00:00:00Z",
    sessionIds: ["s1"],
    open: false,
    axes,
    extras: emptyExtras(),
    events: emptyEvents(),
    usage: emptyUsage(),
    delivery: { num: 0, den: 0 },
    coverage: { observable: 0, offChannel: 0, opaque: 0 },
  } as Period;
}

const statOf = (period: Period, key: string) =>
  computeStats(period).find((s) => s.key === key);

describe("널 하네스 바닥", () => {
  it("인덱스 검색만 반복하면 탐색력이 만점이 나온다", () => {
    // 이것이 결함이다. 파일 찾기와 근거 확보는 분모가 0 이라 빠지고 인덱스 하나만 남는다.
    const stat = statOf(
      periodOf((a) => {
        a.indexedRetrieval = { num: 0, den: 40 };
      }),
      "retrieval",
    );
    expect(stat?.score).toBe(100);
  });

  it("그 점수가 몇 개로 나왔는지는 반드시 밖으로 나온다", () => {
    // 결함을 없앨 수 없다면 감추지는 않는다. 이 단언이 깨지면 화면이 거짓말을 한다.
    const stat = statOf(
      periodOf((a) => {
        a.indexedRetrieval = { num: 0, den: 40 };
      }),
      "retrieval",
    );
    expect(stat?.scoredCount).toBe(1);
    expect(stat?.scorableCount).toBe(3);
    expect(stat?.scoredCount).toBeLessThan(stat?.scorableCount ?? 0);
  });

  it("아무것도 안 한 하네스는 점수 자체가 없다", () => {
    for (const stat of computeStats(periodOf(() => {}))) {
      expect(stat.score).toBeNull();
      expect(stat.scoredCount).toBe(0);
    }
  });

  it("전부 잰 스탯은 채점 수와 대상 수가 같다", () => {
    const stat = statOf(
      periodOf((a) => {
        a.readScope = { num: 5, den: 10 };
        a.readRevisit = { num: 2, den: 10 };
      }),
      "context",
    );
    // 응답 간결성·컨텍스트 경량성은 usage 가 비어 분모가 0 이다.
    expect(stat?.scoredCount).toBeLessThan(stat?.scorableCount ?? 0);
  });

  it("표시 전용은 채점 대상 수에서도 빠진다", () => {
    // 완수력은 구성요소가 둘인데 산출물 도달이 표시 전용이라 대상은 하나다.
    const stat = statOf(
      periodOf(() => {}),
      "delivery",
    );
    expect(stat?.scorableCount).toBe(1);
  });
});
