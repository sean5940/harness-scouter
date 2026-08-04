import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "./version.js";

/**
 * 단일 실행파일 안에서는 package.json 을 읽을 수 없어 버전을 상수로 둔다.
 * 사본이 둘이면 한쪽만 고치는 일이 생기므로 여기서 묶는다.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("VERSION", () => {
  it("루트 package.json 과 같다", () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it("cli package.json 과 같다", () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "packages/cli/package.json"), "utf8"),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
