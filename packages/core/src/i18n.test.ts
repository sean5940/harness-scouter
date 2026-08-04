import { describe, expect, it } from "vitest";
import { L, resolveLang, t, tList } from "./i18n.js";

describe("resolveLang", () => {
  it("명시값이 가장 우선한다", () => {
    expect(resolveLang("en", { LANG: "ko_KR.UTF-8", SCOUTER_LANG: "ko" })).toBe(
      "en",
    );
    expect(resolveLang("ko", { LANG: "en_US.UTF-8" })).toBe("ko");
  });

  it("대소문자를 가리지 않는다", () => {
    expect(resolveLang("EN", {})).toBe("en");
    expect(resolveLang("Ko", {})).toBe("ko");
  });

  it("모르는 언어는 조용히 넘어가지 않고 던진다", () => {
    expect(() => resolveLang("ja", {})).toThrow(/ja/);
  });

  it("명시값이 없으면 SCOUTER_LANG 을 본다", () => {
    expect(resolveLang(undefined, { SCOUTER_LANG: "ko", LANG: "en_US" })).toBe(
      "ko",
    );
  });

  it("SCOUTER_LANG 이 이상하면 로케일로 넘어간다", () => {
    expect(
      resolveLang(undefined, { SCOUTER_LANG: "klingon", LANG: "ko_KR.UTF-8" }),
    ).toBe("ko");
  });

  it("로케일 앞 두 글자로 판정한다", () => {
    expect(resolveLang(undefined, { LANG: "ko_KR.UTF-8" })).toBe("ko");
    expect(resolveLang(undefined, { LANG: "en_US.UTF-8" })).toBe("en");
  });

  it("LC_ALL 이 LANG 보다 우선한다", () => {
    expect(resolveLang(undefined, { LC_ALL: "en_US", LANG: "ko_KR" })).toBe(
      "en",
    );
  });

  it("아무 단서가 없으면 영어다", () => {
    expect(resolveLang(undefined, {})).toBe("en");
    expect(resolveLang(undefined, { LANG: "ja_JP.UTF-8" })).toBe("en");
    expect(resolveLang("", { LANG: "" })).toBe("en");
  });
});

describe("t / tList", () => {
  it("언어에 맞는 값을 낸다", () => {
    const v = L("탐색력", "Retrieval");
    expect(t(v, "ko")).toBe("탐색력");
    expect(t(v, "en")).toBe("Retrieval");
  });

  it("항목 수가 언어마다 달라도 된다", () => {
    const list = { ko: ["하나", "둘"], en: ["one"] };
    expect(tList(list, "ko")).toHaveLength(2);
    expect(tList(list, "en")).toHaveLength(1);
  });
});
