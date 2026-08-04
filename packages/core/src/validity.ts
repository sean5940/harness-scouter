import { L, type Localized } from "./i18n.js";

/**
 * 타당성 검증의 현재 상태.
 *
 * 이 점수가 실제 품질과 상관있다는 외부 근거가 아직 없다. 그 사실을 코드에 남긴다.
 * 화면이 등급을 띄우면서 이 한계를 안 적으면 읽는 사람이 근거가 있다고 오해한다.
 *
 * 두 번의 시도가 있었고 둘 다 기각됐다. 다음 사람이 같은 길을 다시 가지 않도록
 * 무엇을 왜 버렸는지 수치와 함께 남긴다.
 */

export interface ValidityAttempt {
  name: string;
  /** 왜 시도했나. */
  premise: string;
  /** 왜 기각했나. 측정으로. */
  rejection: string;
  measurements: string[];
}

export const VALIDITY_ATTEMPTS: ValidityAttempt[] = [
  {
    name: "사람이 붙인 세션 라벨",
    premise:
      "좋은 세션과 나쁜 세션을 사람이 30건 표시하면 점수가 그것과 상관있는지 볼 수 있다.",
    rejection:
      "설계가 도구의 전제와 어긋난다. 이 도구는 트랜스크립트에서 자동으로 재는데 검증만 사람에게 의존하면, 세션마다 사람이 판정해야 해서 확장이 안 되고, 남의 하네스를 평가하려면 그 사람의 라벨을 받아야 하고, 사람이 이미 좋고 나쁨을 안다면 도구가 무엇을 더하는지 불분명하다.",
    measurements: ["수집한 라벨 0건. 측정 없이 설계 단계에서 기각했다."],
  },
  {
    name: "PR 결과 (머지·리뷰 라운드·코멘트)",
    premise:
      "품질의 외부 근거는 사람 머릿속이 아니라 git 과 GitHub 에 이미 기록돼 있다.",
    rejection:
      "신호에 변별력이 없고, 있는 신호는 사전 가설과 반대 방향으로 나왔다. 그리고 세션과 PR 을 잇는 링크가 저작이 아니라 동거였다.",
    measurements: [
      "머지 여부: 저장소 PR 509건 중 453건 머지(89%). 세션 연결분 114건 중 105건(92%). 변별력이 거의 없다.",
      "변경 요청: 509건 중 2건. 세션 연결분에서는 1건. 신호가 아니다.",
      "사전 가설 3개 중 2개가 반대 방향. 검증력 대 리뷰 라운드 +0.201(가설은 음), 탐색력 대 코멘트 +0.134(가설은 음).",
      "가장 큰 상관이 자율성 대 코멘트 수 0.286. 인과 경로가 없다고 사전 선언한 축이다.",
      "pr-link 세션 162개 중 실제로 PR 을 만든 세션은 93개(57.4%). pr-link 시각이 세션 시작 이후인 것이 237/237. 저작이 아니라 동거다.",
    ],
  },
];

export interface ValidityState {
  /** 바깥 기준에 맞춰 검증됐는가. 지금은 항상 거짓이다. */
  externallyValidated: boolean;
  /** 화면에 함께 적을 한 문장. */
  caveat: Localized;
}

/**
 * 지금 상태.
 *
 * 게이트의 뜻을 바꿨다. "통과하면 등급을 신뢰한다"가 아니라 "통과 전에는 등급이
 * 무엇에 근거하는지 함께 적는다"이다. 통과를 만들어내는 것보다 근거 없음을 감추지
 * 않는 쪽이 정직하고, 사람 라벨로 돌아가지 않는 유일한 길이다.
 */
export function validityState(): ValidityState {
  return {
    externallyValidated: false,
    caveat: L(
      "이 등급은 내 이력 대비 위치입니다. 실제 품질과 상관있다는 외부 근거는 아직 없습니다. PR 결과로 검증을 시도했으나 신호에 변별력이 없었고 사전 가설과 반대 방향이 나왔습니다.",
      "This grade is a position against my own history. There is still no external evidence that it correlates with real quality. Validation against PR outcomes was attempted, but the signals had no discriminating power and came out opposite to the pre-registered hypotheses.",
    ),
  };
}
