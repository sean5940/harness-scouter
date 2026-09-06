import { describe, expect, it } from "vitest";

import { MIN_COVERAGE_TO_SCORE } from "../src/capability.js";
import {
  emptyAxes,
  emptyCapability,
  emptyExtras,
  type CapabilityCounts,
} from "../src/metrics.js";
import { emptyEvents, emptyUsage, type Period } from "../src/periods.js";
import { buildStatWindow } from "../src/stats.js";

/**
 * 매핑표가 낡았을 때 소리가 나는지 본다.
 *
 * README 는 "커버리지가 90% 아래로 떨어지면 점수를 내지 않고 무엇이 안 잡혔는지를
 * 보여줍니다" 라고 적어 두고, 정작 `MIN_COVERAGE_TO_SCORE` 와 `measureCoverage()` 를
 * 부르는 프로덕션 경로가 없었다. 세션마다 세던 매핑 카운터도 구간으로 올라오는 길이
 * 없어 아무도 읽지 못했다. 그래서 커버리지 77% 짜리 코퍼스에서 점수가 그대로 나왔다.
 *
 * 두 세계를 만든다. 프로필이 호출을 다 알아본 세계와 열에 셋을 모르는 세계에 **똑같은
 * 축 값**을 넣는다. 앞은 점수가 나오고 뒤는 점수 대신 안 잡힌 이름이 나와야 한다.
 * 뒤에서 점수가 나오면 그 화면은 하네스가 아니라 프로필의 빈칸을 보여주는 것이다.
 */

function periodOf(index: number, capability: CapabilityCounts): Period {
  const axes = emptyAxes();
  axes.readScope = { num: 80, den: 100 };
  axes.indexedRetrieval = { num: 50, den: 200 };
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
    capability,
    open: false,
  } as Period;
}

const allMapped: CapabilityCounts = {
  total: 1000,
  mapped: 1000,
  unmapped: {},
};

/** 열에 셋을 모르는 프로필. 낡은 매핑표의 모양이다. */
const staleMapping: CapabilityCounts = {
  total: 1000,
  mapped: 700,
  unmapped: { read_file: 180, apply_patch: 90, shell_exec: 30 },
};

function windowOf(capability: CapabilityCounts) {
  return buildStatWindow(
    periodOf(9, capability),
    [0, 1, 2, 3, 4].map((i) => periodOf(i, capability)),
  );
}

describe("모르는 호출이 많으면 점수를 내지 않는다", () => {
  it("다 알아본 창은 점수를 낸다", () => {
    const w = windowOf(allMapped);
    expect(w.capabilityCoverage).toBe(1);
    expect(w.scoreWithheld).toBe(null);
    expect(w.overall).not.toBe(null);
    expect(w.judgeable).toBe(true);
  });

  it("열에 셋을 모르는 창은 점수를 보류한다", () => {
    // 같은 축 값인데 프로필만 낡았다. 여기서 점수가 나오면 남의 하네스가 나빠서
    // 낮은 것처럼 읽힌다.
    const w = windowOf(staleMapping);
    expect(w.capabilityCoverage).toBeLessThan(MIN_COVERAGE_TO_SCORE);
    expect(w.scoreWithheld).toBe("capability");
    expect(w.judgeable).toBe(false);
  });

  it("점수 대신 무엇이 안 잡혔는지를 낸다", () => {
    // 보류만 하고 이유를 안 내면 고칠 방법이 없다. 많은 것부터 낸다.
    const w = windowOf(staleMapping);
    expect(w.unmappedTop.map((u) => u.name)).toEqual([
      "read_file",
      "apply_patch",
      "shell_exec",
    ]);
    expect(w.unmappedTop[0]?.count).toBe(180);
  });

  it("바닥 바로 위에서는 점수가 나온다", () => {
    // 임계가 실제로 그 값인지 본다. 한 칸 차이로 뒤집히지 않으면 임계가 아니다.
    const justAbove = windowOf({
      total: 1000,
      mapped: Math.ceil(MIN_COVERAGE_TO_SCORE * 1000),
      unmapped: { read_file: 100 },
    });
    const justBelow = windowOf({
      total: 1000,
      mapped: Math.ceil(MIN_COVERAGE_TO_SCORE * 1000) - 1,
      unmapped: { read_file: 101 },
    });
    expect(justAbove.scoreWithheld).toBe(null);
    expect(justBelow.scoreWithheld).toBe("capability");
  });

  it("호출이 하나도 없으면 보류하지 않는다", () => {
    // 분모가 0 인 것은 매핑이 낡았다는 뜻이 아니다. 못 잰 것을 실패로 세지 않는다.
    const w = windowOf(emptyCapability());
    expect(w.capabilityCoverage).toBe(null);
    expect(w.scoreWithheld).toBe(null);
  });
});
