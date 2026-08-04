/**
 * 번들을 Node 런타임과 합쳐 단일 실행파일로 만든다.
 *
 * 받는 사람에게 "Node 22.5 이상을 먼저 까세요"를 요구하지 않으려는 것이다. 대가는 크기다.
 * 런타임이 통째로 들어가 105MB 안팎이 된다. Node 가 이미 있는 사람은 npm 경로가 낫다.
 *
 * macOS 는 서명된 바이너리를 수정하면 실행을 막으므로, 주입 전에 서명을 떼고 다시 붙인다.
 * 이 재서명은 ad-hoc 이라 Gatekeeper 를 통과하지 못한다. 배포본을 처음 열 때 사용자가
 * 우클릭 열기를 해야 하는 이유이고, 공증(notarization)은 유료 개발자 계정이 필요해 넣지 않았다.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  chmodSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");
const BUNDLE = join(BUILD, "bundle.cjs");
const TARGET = process.env.SEA_TARGET ?? `${process.platform}-${process.arch}`;
const OUT = join(BUILD, "scouter");

if (!existsSync(BUNDLE)) {
  console.error(
    `번들이 없습니다: ${BUNDLE}\nnode scripts/bundle.mjs 를 먼저 돌리세요.`,
  );
  process.exit(1);
}

const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit" });

mkdirSync(BUILD, { recursive: true });

const configPath = join(BUILD, "sea-config.json");
writeFileSync(
  configPath,
  JSON.stringify(
    {
      main: BUNDLE,
      output: join(BUILD, "sea-prep.blob"),
      disableExperimentalSEAWarning: true,
    },
    null,
    2,
  ),
);

console.log("blob 만드는 중");
run(process.execPath, ["--experimental-sea-config", configPath]);

console.log("런타임 복사");
copyFileSync(process.execPath, OUT);
chmodSync(OUT, 0o755);

if (process.platform === "darwin") {
  try {
    run("codesign", ["--remove-signature", OUT]);
  } catch {
    // 서명이 없던 빌드면 실패하는데 그대로 진행하면 된다.
  }
}

console.log("주입");
const postjectArgs = [
  "--yes",
  "postject@1.0.0-alpha.6",
  OUT,
  "NODE_SEA_BLOB",
  join(BUILD, "sea-prep.blob"),
  "--sentinel-fuse",
  FUSE,
];
if (process.platform === "darwin") {
  postjectArgs.push("--macho-segment-name", "NODE_SEA");
}
run("npx", postjectArgs);

if (process.platform === "darwin") {
  run("codesign", ["--sign", "-", OUT]);
}

console.log("압축");
run("tar", [
  "-czf",
  join(BUILD, `scouter-${TARGET}.tar.gz`),
  "-C",
  BUILD,
  "scouter",
]);

const mb = (statSync(OUT).size / 1024 / 1024).toFixed(0);
const tgz = (
  statSync(join(BUILD, `scouter-${TARGET}.tar.gz`)).size /
  1024 /
  1024
).toFixed(0);
console.log(`${OUT}  ${mb}MB (압축 ${tgz}MB)`);
