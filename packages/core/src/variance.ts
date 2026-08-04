/**
 * 비율 지표의 분산을 참분산과 표본잡음으로 가른다.
 *
 * "구간을 2·3·4배로 묶어도 재현성이 안 나아진다"를 결함으로 적어 뒀는데, 그것이 결함인지
 * 수학적 필연인지 구별한 적이 없다. 축이 전부 num/den 이라 관측 분산은 두 조각의 합이다.
 *
 *   관측 분산 = 참분산(σ²p) + 표본잡음(이항)
 *
 * 표본잡음만 분모 n 으로 나뉘고 참분산은 안 나뉜다. 그래서 참분산이 작으면 분모를 아무리
 * 키워도 신뢰도가 안 오른다. 이것이 사실이면 "묶어도 안 나아진다"는 고쳐야 할 결함이 아니라
 * 애초에 예측되는 결과이고, 고칠 것은 지표가 아니라 무엇을 측정 대상으로 삼았는지다.
 *
 * 적률법(베타-이항)을 쓴다. 우도 최적화가 필요 없어 의존성 없이 40줄로 끝나고, 여기서
 * 필요한 것은 정밀한 모수 추정이 아니라 두 조각의 크기 비교다.
 */

/** 관측 하나. 비율 지표의 분자와 분모. */
export interface RatioObservation {
  num: number;
  den: number;
}

export interface VarianceComponents {
  /** 쓸 수 있는 관측 수. den 이 0 인 것은 뺀다. */
  observations: number;
  /** 전체 비율. 분자 합 / 분모 합. */
  mean: number;
  /** 관측된 비율의 분산. 참분산과 표본잡음이 섞여 있다. */
  observedVariance: number;
  /** 분모 크기에서 따라 나오는 이항 잡음의 기댓값. */
  samplingVariance: number;
  /**
   * 참분산. 관측 분산에서 표본잡음을 뺀 것.
   *
   * 음수가 나올 수 있고 그것은 실패가 아니라 결과다. 관측이 이항잡음보다도 덜 흔들린다는
   * 뜻이고, 잴 것이 거의 없다는 신호다. 0 으로 자르지 않고 그대로 낸다.
   */
  trueVariance: number;
  /**
   * 신뢰도가 0.5 가 되는 분모.
   *
   * 이만큼 모으면 참신호와 잡음이 반반이다. 구간 예산(PERIOD_BUDGET)과 대조하면 그 예산이
   * 애초에 도달 가능한 값인지 알 수 있다. 참분산이 0 이하면 도달 불가라 null 이다.
   */
  halfReliabilityDenominator: number | null;
}

/**
 * 목표 신뢰도에 필요한 분모 (D-study).
 *
 * 게이트를 "미달"이라는 이진 판정에서 "구간당 N 이 필요한데 지금 M"이라는 처방으로 바꾼다.
 */
export function denominatorForReliability(
  components: VarianceComponents,
  target: number,
): number | null {
  const k = components.halfReliabilityDenominator;
  if (k === null || target <= 0 || target >= 1) return null;
  // R = n / (n + k) 를 n 에 대해 푼다.
  return Math.ceil((k * target) / (1 - target));
}

/** 분모 n 에서 기대되는 신뢰도. */
export function reliabilityAt(
  components: VarianceComponents,
  n: number,
): number | null {
  const k = components.halfReliabilityDenominator;
  if (k === null || n <= 0) return null;
  return n / (n + k);
}

/**
 * 관측 묶음에서 분산 성분을 뽑는다.
 *
 * 가중은 분모로 준다. 세션마다 분모가 2 에서 200 까지 벌어지므로, 균등가중을 쓰면 분모가
 * 얇은 세션의 큰 튐이 참분산을 부풀린다.
 */
export function decomposeVariance(
  observations: ReadonlyArray<RatioObservation>,
): VarianceComponents | null {
  const usable = observations.filter(
    (o) => o.den > 0 && Number.isFinite(o.num) && Number.isFinite(o.den),
  );
  if (usable.length < 3) return null;

  const totalDen = usable.reduce((s, o) => s + o.den, 0);
  const totalNum = usable.reduce((s, o) => s + o.num, 0);
  if (totalDen === 0) return null;
  const mean = totalNum / totalDen;

  // 분모 가중 관측 분산.
  let weighted = 0;
  for (const o of usable) {
    const p = o.num / o.den;
    weighted += o.den * (p - mean) ** 2;
  }
  const observedVariance = weighted / totalDen;

  // 이항 잡음의 기댓값.
  //
  // 조화평균 분모를 쓰면 안 된다. 세션마다 분모가 1 에서 200 까지 벌어져 조화평균이 작은
  // 쪽에 끌려가고, 그러면 잡음을 참값의 2.6배로 부풀려 참분산이 통째로 음수가 된다.
  // 처음에 그렇게 짰다가 6축 중 4축이 음수로 나와 유도해 보고 알았다.
  //
  // 가중 관측분산의 기댓값을 직접 유도하면 이렇다. w_i = den_i, W = Σden 일 때
  //   E[(p_i - p̄)²] = p(1-p)(1/den_i - 1/W)
  //   E[Σ w_i (p_i - p̄)²] = p(1-p) Σ(1 - den_i/W) = p(1-p)(n - 1)
  // 따라서 E[관측분산] = p(1-p)(n-1)/W 다.
  const samplingVariance = (mean * (1 - mean) * (usable.length - 1)) / totalDen;

  const trueVariance = observedVariance - samplingVariance;

  // k = μ(1−μ)/σ²p. 참분산이 0 이하면 어떤 분모로도 신뢰도가 안 올라 null 이다.
  const halfReliabilityDenominator =
    trueVariance > 0 ? (mean * (1 - mean)) / trueVariance : null;

  return {
    observations: usable.length,
    mean,
    observedVariance,
    samplingVariance,
    trueVariance,
    halfReliabilityDenominator,
  };
}

/**
 * 참분산이 표본잡음에 견줘 얼마나 큰가.
 *
 * 1 을 넘으면 관측된 흔들림의 절반 이상이 진짜 차이다. 0 에 가까우면 보고 있는 것이 거의
 * 잡음이고, 그때는 분모를 키우는 것으로 해결되지 않는다.
 */
export function signalToNoise(components: VarianceComponents): number {
  if (components.samplingVariance <= 0) return 0;
  return components.trueVariance / components.samplingVariance;
}
