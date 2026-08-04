/**
 * 화면 언어.
 *
 * 문자열을 별도 카탈로그 파일로 빼지 않고 정의 옆에 둔다. 이 저장소에서 반복해 겪은
 * 결함이 문서와 코드의 drift 였기 때문이다. 앵커값을 1,000/4,500 으로 고쳤는데 설명은
 * 500/4,000 으로 남아 있던 식이다. 설명 문구를 그것이 설명하는 정의에서 떼어 놓으면
 * 같은 drift 가 코드 안에서 재발한다.
 *
 * 대신 타입으로 강제한다. `Localized` 는 두 언어를 모두 요구하므로 한쪽만 있는 문자열은
 * 컴파일이 안 된다. 번역 누락이 런타임 빈 문자열로 새지 않는다.
 */
export type Lang = "ko" | "en";

export const LANGS: readonly Lang[] = ["ko", "en"];

/** 두 언어를 모두 가진 문자열. 한쪽만 채우는 것은 타입이 막는다. */
export interface Localized {
  ko: string;
  en: string;
}

export function t(value: Localized, lang: Lang): string {
  return value[lang];
}

/** 문자열 배열의 다국어판. 언어마다 항목 수가 달라도 된다. */
export interface LocalizedList {
  ko: string[];
  en: string[];
}

export function tList(value: LocalizedList, lang: Lang): string[] {
  return value[lang];
}

function isLang(value: string): value is Lang {
  return (LANGS as readonly string[]).includes(value);
}

/**
 * 쓸 언어를 정한다. 명시값, SCOUTER_LANG, LANG/LC_ALL, 영어 순으로 본다.
 *
 * 로케일 환경변수는 `ko_KR.UTF-8` 처럼 오므로 앞 두 글자만 본다. 한국어 환경에서는
 * 지금까지와 똑같이 동작하고, 그 밖에서는 영어가 나온다.
 */
export function resolveLang(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): Lang {
  if (explicit !== undefined && explicit !== "") {
    const normalized = explicit.toLowerCase();
    if (isLang(normalized)) return normalized;
    throw new Error(
      `알 수 없는 언어: ${explicit} (지원: ${LANGS.join(", ")}) / unknown language`,
    );
  }
  const configured = env.SCOUTER_LANG;
  if (configured !== undefined && configured !== "") {
    const normalized = configured.toLowerCase();
    if (isLang(normalized)) return normalized;
  }
  const locale = env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? "";
  const prefix = locale.slice(0, 2).toLowerCase();
  return isLang(prefix) ? prefix : "en";
}

/** 정의 옆에 두 언어를 나란히 적기 위한 짧은 생성자. */
export function L(ko: string, en: string): Localized {
  return { ko, en };
}
