import { describe, expect, it } from "vitest";

import { AXIS_ORDER } from "../src/definitions.js";
import { emptyAxes, emptyExtras, type SessionMetrics } from "../src/metrics.js";
import {
  emptyEvents,
  emptyUsage,
  type SessionForPeriod,
} from "../src/periods.js";
import { seededRandom } from "../src/gate.js";
import {
  placeboSeeds,
  runStratificationExperiment,
  sensitivityOf,
} from "../src/stratify.js";
import {
  emptyWorkload,
  WORK_TYPE_VARIANTS,
  type WorkloadCounts,
} from "../src/worktype.js";

/**
 * 실험의 배선을 본다. 값이 맞는지는 `stratifiedSplitHalf.test.ts` 가 아는 답으로 보고,
 * 여기서는 층화 전 대조군이 변형마다 다시 계산되어 표마다 다른 수로 적히지 않는지를 본다.
 * 같은 수를 두 화면이 다르게 적는 것이 이 저장소에서 반복해 나온 결함이다.
 */

/** 코드 편집만 있는 세션. 기존 수정으로 분류된다. */
function modifyWorkload(codeEdits: number): WorkloadCounts {
  return { ...emptyWorkload(), codeEdits };
}

/** 새 파일만 만든 세션. 신규 구현으로 분류된다. */
function buildWorkload(codeEdits: number): WorkloadCounts {
  return { ...emptyWorkload(), codeEdits, createdCodeFiles: codeEdits };
}

function world(sessionCount: number): {
  sessions: SessionMetrics[];
  forPeriods: SessionForPeriod[];
  workload: Map<string, WorkloadCounts>;
} {
  const sessions: SessionMetrics[] = [];
  const forPeriods: SessionForPeriod[] = [];
  const workload = new Map<string, WorkloadCounts>();

  for (let i = 0; i < sessionCount; i += 1) {
    const sessionId = `s${String(i).padStart(3, "0")}`;
    const axes = emptyAxes();
    // 채울 수 있는 축을 하나만 둔다. 구간이 닫히는 조건이 그 축의 예산 하나가 되어
    // 구간 크기를 세션 수로 정확히 조절할 수 있다.
    axes.readRevisit = { num: i % 4, den: 3 };
    const metrics: SessionMetrics = {
      sessionId,
      axes,
      extras: emptyExtras(),
      coverage: { observable: 0, offChannel: 0, opaque: 0 },
      capability: { total: 0, mapped: 0, unmapped: {} },
      verifierOutcomeUnknown: 0,
      blockedCalls: 0,
    };
    sessions.push(metrics);
    forPeriods.push({
      metrics,
      startedAt: new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
      endedAt: new Date(Date.UTC(2026, 0, 1, i, 30)).toISOString(),
      events: emptyEvents(),
      usage: emptyUsage(),
      reachedArtifact: false,
    });
    // 층을 둘로 갈라 넣는다. 한 층에 다 들어가면 층화가 아무것도 안 가른다.
    workload.set(sessionId, i % 2 === 0 ? modifyWorkload(4) : buildWorkload(4));
  }

  return { sessions, forPeriods, workload };
}

describe("층화 실험", () => {
  it("임계 변형마다 한 줄씩 낸다", () => {
    const w = world(120);
    const e = runStratificationExperiment(w.sessions, w.forPeriods, w.workload);
    expect(e.variants).toHaveLength(WORK_TYPE_VARIANTS.length);
    expect(e.sessionCount).toBe(120);
    for (const variant of e.variants) {
      expect(variant.axes.map((a) => a.axis)).toEqual(AXIS_ORDER);
    }
  });

  it("층화 전 대조군은 변형마다 같은 값이다", () => {
    // 임계는 층을 바꿀 뿐 층화하지 않은 쪽을 바꾸지 않는다. 변형마다 다시 계산해
    // 다른 수가 나오면 표를 세로로 읽을 수 없다.
    const w = world(120);
    const e = runStratificationExperiment(w.sessions, w.forPeriods, w.workload);
    const first = e.variants[0];
    expect(first).toBeDefined();
    for (const variant of e.variants.slice(1)) {
      variant.axes.forEach((row, i) => {
        expect(row.plain?.median).toBe(first?.axes[i]?.plain?.median);
      });
    }
  });

  it("층 크기의 합이 세션 수와 같다", () => {
    // 어느 층에도 안 들어간 세션이 있으면 층화가 일부만 보고 판정한 것이 된다.
    const w = world(60);
    const e = runStratificationExperiment(w.sessions, w.forPeriods, w.workload);
    for (const variant of e.variants) {
      const total = Object.values(variant.sizes).reduce((s, n) => s + n, 0);
      expect(total).toBe(e.sessionCount);
    }
    expect(e.variants[0]?.occupiedStrata).toBe(2);
  });

  it("구간이 모자라면 축을 못 내고 그 사실이 남는다", () => {
    // 못 낸 것을 0 으로 접으면 "층화가 효과 없다"로 읽힌다.
    const w = world(8);
    const e = runStratificationExperiment(w.sessions, w.forPeriods, w.workload);
    expect(e.usablePeriods).toBeLessThan(3);
    for (const row of e.variants[0]?.axes ?? []) {
      expect(row.plain).toBeNull();
      expect(row.delta).toBeNull();
      expect(row.verdictBefore).toBe("not-computable");
    }
  });

  it("위약 대조를 축마다 함께 낸다", () => {
    // 위약이 빠지면 "올라감"을 작업 구성의 증거로 읽을 수 없다. 표에 늘 같이 실린다.
    const w = world(120);
    const e = runStratificationExperiment(w.sessions, w.forPeriods, w.workload);
    expect(e.placebo.map((p) => p.axis)).toEqual(AXIS_ORDER);
    const measured = e.placebo.find((p) => p.axis === "readRevisit");
    expect(measured?.placebo).not.toBeNull();
    expect(measured?.delta).not.toBeNull();
    // 뽑기 폭이 있어야 위약이 스스로 얼마나 흔들리는지 읽을 수 있다.
    expect(measured?.deltaRange).not.toBeNull();
    expect(measured?.deltaRange?.max).toBeGreaterThanOrEqual(
      measured?.deltaRange?.min ?? 0,
    );
    // 가운데 뽑기는 폭 안에 있어야 한다. 밖이면 둘이 다른 것을 재고 있다.
    expect(measured?.delta).toBeGreaterThanOrEqual(
      measured?.deltaRange?.min ?? 0,
    );
    expect(measured?.delta).toBeLessThanOrEqual(measured?.deltaRange?.max ?? 0);
  });

  it("위약 뽑기 시드는 서로 멀리 떨어져 있다", () => {
    // 시드를 1씩 올리면 안 된다. seededRandom 이 선형 합동이라 이웃 시드의 첫 출력이
    // 거의 같아, 세 뽑기가 앞쪽 구간에서 사실상 같은 섞기를 한다. 뽑기를 셋으로 늘린
    // 값이 통째로 사라지는데 코드는 멀쩡히 돌고 값도 그럴듯해 눈으로는 못 잡는다.
    const seeds = placeboSeeds(3);
    expect(new Set(seeds).size).toBe(3);
    const firsts = seeds.map((s) => seededRandom(s)());
    for (let i = 0; i < firsts.length; i += 1) {
      for (let j = i + 1; j < firsts.length; j += 1) {
        expect(
          Math.abs((firsts[i] as number) - (firsts[j] as number)),
        ).toBeGreaterThan(0.05);
      }
    }
  });

  it("유형을 못 매긴 세션을 세고 층 수에 넣는다", () => {
    // 버리면 층화 전후가 다른 모집단을 재고, 안 세면 "층화가 가르는 것이 없다"를
    // 적으면서 실제로는 아는 것과 모르는 것으로 가르게 된다.
    const w = world(60);
    const partial = new Map(w.workload);
    for (const sid of Array.from(partial.keys()).slice(0, 20))
      partial.delete(sid);
    const e = runStratificationExperiment(w.sessions, w.forPeriods, partial);
    expect(e.unknownSessions).toBe(20);
    const sized = Object.values(e.variants[0]?.sizes ?? {}).reduce(
      (s, n) => s + n,
      0,
    );
    expect(sized + e.unknownSessions).toBe(e.sessionCount);
    // 작업 유형 둘 + 모르는 층 하나.
    expect(e.variants[0]?.occupiedStrata).toBe(3);
  });

  it("층화 전을 못 내면 위약도 이동을 안 적는다", () => {
    // 대조군이 없는데 위약 이동만 적으면 어디서 얼마나 움직였는지 모르는 수가 남는다.
    const w = world(8);
    const e = runStratificationExperiment(w.sessions, w.forPeriods, w.workload);
    for (const row of e.placebo) {
      expect(row.delta).toBeNull();
    }
  });

  it("민감도는 축마다 이동 범위와 부호 안정성을 낸다", () => {
    const w = world(120);
    const e = runStratificationExperiment(w.sessions, w.forPeriods, w.workload);
    const s = sensitivityOf(e);
    expect(s.map((x) => x.axis)).toEqual(AXIS_ORDER);
    const measured = s.find((x) => x.axis === "readRevisit");
    expect(measured).toBeDefined();
    expect(measured?.min).not.toBeNull();
    expect(measured?.max).toBeGreaterThanOrEqual(measured?.min ?? 0);
    // 분모가 0 인 축은 delta 를 못 내므로 안정으로 세면 안 된다.
    const unfilled = s.find((x) => x.axis === "readScope");
    expect(unfilled?.signStable).toBe(false);
    expect(unfilled?.min).toBeNull();
  });
});
