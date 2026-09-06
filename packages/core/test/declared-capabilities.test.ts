import { describe, expect, it } from "vitest";

import {
  CLAUDE_CODE_PROFILE,
  availableCapabilities,
  parseCapabilities,
  type Capability,
} from "../src/capability.js";
import { emptyAxes, emptyExtras } from "../src/metrics.js";
import { emptyEvents, emptyUsage, type Period } from "../src/periods.js";
import { buildStatWindow } from "../src/stats.js";

/**
 * 없는 능력을 0 이 아니라 판정 불가로 내는지 본다.
 *
 * `availableCapabilities` 와 `axisMeasurable` 은 이미 있었는데 프로필을 밖에서 줄 길이
 * 없어서 실제로는 안 걸렸다. 매핑에 `Grep` 이 있는 한 `index-search` 도 있는 것으로
 * 잡히고, 인덱스 검색 도구가 없는 하네스에서는 감점 분자만 차서 구조적으로 0 이 된다.
 *
 * 그래서 두 세계를 만든다. 인덱스 검색이 있다고 선언한 세계와 없다고 선언한 세계에
 * **똑같은 코퍼스**를 넣는다. 앞은 0 점, 뒤는 판정 불가여야 한다. 뒤가 0 점이면 화면이
 * "안 썼다" 와 "없다" 를 같은 말로 하고 있는 것이다.
 */

/** 인덱스 검색을 한 번도 안 쓰고 grep 만 쓴 구간. */
function grepOnlyPeriod(index: number): Period {
  const axes = emptyAxes();
  // 이 축은 뒤집힌 축이라 분자가 감점이다. grep 이 분자와 분모를 함께 채우고,
  // 인덱스 도구가 없으면 좋은 쪽을 채울 방법이 아예 없어 구조적으로 0 이 된다.
  axes.indexedRetrieval = { num: 200, den: 200 };
  axes.readScope = { num: 80, den: 100 };
  const extras = emptyExtras();
  extras.fileFind = { num: 40, den: 50 };
  extras.groundedEdit = { num: 45, den: 50 };
  return {
    index,
    sessionIds: [`s${index}`],
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-02T00:00:00Z",
    axes,
    extras,
    events: emptyEvents(),
    usage: emptyUsage(),
    delivery: { num: 0, den: 0 },
    coverage: { observable: 100, offChannel: 0, opaque: 0 },
    open: false,
  } as Period;
}

function retrievalScore(available?: ReadonlySet<Capability>): number | null {
  const current = grepOnlyPeriod(9);
  const history = [0, 1, 2, 3, 4].map(grepOnlyPeriod);
  const w = buildStatWindow(current, history, { available });
  const retrieval = w.stats.find((s) => s.key === "retrieval");
  return (
    retrieval?.components.find((c) => c.key === "indexedRetrieval")?.value ??
    null
  );
}

describe("능력 선언을 밖에서 받는다", () => {
  it("이름을 잘못 적으면 조용히 버리지 않고 돌려준다", () => {
    // 조용히 버리면 오타를 낸 사람이 "선언했는데 왜 판정 불가지" 를 영영 못 푼다.
    expect(parseCapabilities("file-read, shell")).toEqual({
      declared: ["file-read", "shell"],
      unknown: [],
    });
    expect(parseCapabilities("file-read,index_search,nope")).toEqual({
      declared: ["file-read"],
      unknown: ["index_search", "nope"],
    });
    expect(parseCapabilities("")).toEqual({ declared: [], unknown: [] });
  });

  it("`other` 는 선언 대상이 아니다", () => {
    // 축이 안 보는 자리라 적어도 아무것도 안 바뀐다. 목록에 있으면 되는 줄 알게 된다.
    expect(parseCapabilities("other").unknown).toEqual(["other"]);
  });
});

describe("없는 능력은 0 이 아니라 판정 불가다", () => {
  it("인덱스 검색이 있는 하네스에서는 0 점이다", () => {
    // 원인이 있는 세계. 도구가 있는데 안 썼으니 0 점이 맞다.
    expect(retrievalScore(new Set(["index-search", "file-read"]))).toBe(0);
  });

  it("인덱스 검색이 없는 하네스에서는 값을 내지 않는다", () => {
    // 원인이 없는 세계. 같은 코퍼스인데 도구가 없으니 물을 수 없는 질문이다.
    expect(retrievalScore(new Set(["file-read", "file-edit", "shell"]))).toBe(
      null,
    );
  });

  it("선언이 없으면 지금까지처럼 프로필에서 추론한다", () => {
    // 선언 경로를 냈다고 기본 동작이 움직이면 안 된다. Claude Code 프로필은
    // 인덱스 검색을 가지므로 0 점이 그대로 나와야 한다.
    expect(retrievalScore()).toBe(0);
    expect(retrievalScore(availableCapabilities(CLAUDE_CODE_PROFILE))).toBe(0);
  });

  it("판정 불가인 축은 점수를 끌어내리지 않는다", () => {
    // 이게 이 변경의 요점이다. 0 으로 평균에 들어가면 없는 도구가 탐색력을 깎는다.
    const withIndex = buildStatWindow(
      grepOnlyPeriod(9),
      [0, 1, 2, 3, 4].map(grepOnlyPeriod),
      { available: new Set(["index-search", "file-read"]) },
    ).stats.find((s) => s.key === "retrieval");
    const withoutIndex = buildStatWindow(
      grepOnlyPeriod(9),
      [0, 1, 2, 3, 4].map(grepOnlyPeriod),
      { available: new Set(["file-read", "file-edit", "shell"]) },
    ).stats.find((s) => s.key === "retrieval");

    expect(withIndex?.score).not.toBeNull();
    expect(withoutIndex?.score).not.toBeNull();
    expect(withoutIndex?.score as number).toBeGreaterThan(
      withIndex?.score as number,
    );
    // 세지 못한 구성요소가 있다는 사실도 함께 남아야 한다.
    expect(withoutIndex?.scoredCount).toBeLessThan(
      withoutIndex?.scorableCount ?? 0,
    );
  });

  it("이력 구간도 같은 선언으로 잰다", () => {
    // 현재 창만 선언을 받으면 백분위가 서로 다른 기준으로 매겨진다. 판정 불가라고
    // 한 축이 이력에서는 0 으로 살아 있어서, 같은 코퍼스인데 등급이 내려간다.
    const noIndex = new Set<Capability>(["file-read", "file-edit", "shell"]);
    const w = buildStatWindow(
      grepOnlyPeriod(9),
      [0, 1, 2, 3, 4].map(grepOnlyPeriod),
      { available: noIndex },
    );
    const retrieval = w.stats.find((s) => s.key === "retrieval");
    // 이력이 같은 기준이면 현재 값과 이력 분포가 같아 통상 구간이 현재 점수를 낀다.
    expect(retrieval?.typicalLow).toBe(retrieval?.score);
    expect(retrieval?.typicalHigh).toBe(retrieval?.score);
  });
});
