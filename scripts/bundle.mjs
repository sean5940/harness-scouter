/**
 * 워크스페이스 ESM 모듈을 SEA 가 먹는 단일 CommonJS 로 접는다.
 *
 * Node 의 SEA 는 CommonJS 만 받는데 이 저장소는 전부 ESM 이다. 번들러를 새로 들이는 대신
 * tsc 가 이미 만든 dist 를 읽어 의존 순서대로 잇는다. 의존이 워크스페이스 안에서 닫혀 있고
 * (런타임 의존성 0개) 순환이 없어서 가능한 방식이다. 둘 중 하나라도 깨지면 esbuild 로 옮겨야 한다.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "packages/cli/dist/index.js");
const OUT_DIR = join(ROOT, "build");
const OUT = join(OUT_DIR, "bundle.cjs");

if (!existsSync(ENTRY)) {
  console.error(
    `빌드 산출물이 없습니다: ${ENTRY}\nnpm run build 를 먼저 돌리세요.`,
  );
  process.exit(1);
}

/** import 경로를 실제 파일로 옮긴다. 워크스페이스 이름과 상대 경로 둘 다 받는다. */
function resolveImport(spec, fromFile) {
  if (spec.startsWith("node:")) return null;
  if (spec.startsWith(".")) {
    const p = resolve(dirname(fromFile), spec);
    return existsSync(p) ? p : null;
  }
  const ws = spec.match(/^@harness-scouter\/([a-z]+)(?:\/(.+))?$/);
  if (ws === null) return null;
  const sub = ws[2] ?? "index.js";
  const p = join(
    ROOT,
    "packages",
    ws[1],
    "dist",
    sub.endsWith(".js") ? sub : `${sub}.js`,
  );
  return existsSync(p) ? p : null;
}

const IMPORT_RE =
  /^\s*import\s+(?:([\w*\s{},$]+)\s+from\s+)?["']([^"']+)["'];?\s*$/gm;
const EXPORT_FROM_RE =
  /^\s*export\s+(?:\*|{[^}]*})\s+from\s+["']([^"']+)["'];?\s*$/gm;
const EXPORT_DECL_RE =
  /^\s*export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm;

const modules = new Map();
const order = [];

function collect(file) {
  if (modules.has(file)) return;
  modules.set(file, null); // 순환 표시
  const src = readFileSync(file, "utf8");
  const deps = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const p = resolveImport(m[2], file);
    if (p !== null) deps.push(p);
  }
  for (const m of src.matchAll(EXPORT_FROM_RE)) {
    const p = resolveImport(m[1], file);
    if (p !== null) deps.push(p);
  }
  for (const d of deps) collect(d);
  modules.set(file, src);
  order.push(file);
}

collect(ENTRY);

// 각 모듈을 함수로 감싸 이름 충돌을 막는다. 최소한의 CJS 로더를 앞에 둔다.
const parts = [
  "'use strict';",
  "const __mods = {};",
  "const __cache = {};",
  "function __req(id) {",
  "  if (__cache[id]) return __cache[id].exports;",
  "  const m = (__cache[id] = { exports: {} });",
  "  __mods[id](m, m.exports, __req);",
  "  return m.exports;",
  "}",
];

for (const file of order) {
  const id = JSON.stringify(file.slice(ROOT.length + 1));
  let src = modules.get(file);

  // shebang 은 파일 첫 줄에서만 유효하다. 모듈을 이어붙이면 중간에 남아 구문 오류가 난다.
  src = src.replace(/^#!.*\n/, "");

  src = src
    .replace(IMPORT_RE, (full, binding, spec) => {
      if (spec.startsWith("node:")) {
        return binding === undefined
          ? ""
          : `const ${toCjsBinding(binding)} = require(${JSON.stringify(spec)});`;
      }
      const p = resolveImport(spec, file);
      if (p === null) return "";
      if (binding === undefined)
        return `__req(${JSON.stringify(p.slice(ROOT.length + 1))});`;
      return `const ${toCjsBinding(binding)} = __req(${JSON.stringify(p.slice(ROOT.length + 1))});`;
    })
    .replace(EXPORT_FROM_RE, (full, spec) => {
      const p = resolveImport(spec, file);
      if (p === null) return "";
      return `Object.assign(exports, __req(${JSON.stringify(p.slice(ROOT.length + 1))}));`;
    })
    .replace(EXPORT_DECL_RE, "")
    .replace(/^\s*export\s*{[^}]*};?\s*$/gm, "");

  // 최상위 선언을 exports 에 붙인다. 이름을 다시 훑어 명시적으로 단다.
  const names = [
    ...src.matchAll(/^(?:async\s+)?function\s+(\w+)/gm),
    ...src.matchAll(/^class\s+(\w+)/gm),
    ...src.matchAll(/^(?:const|let|var)\s+(\w+)/gm),
  ].map((m) => m[1]);
  const assigns = [...new Set(names)]
    .map((n) => `try { exports.${n} = ${n}; } catch {}`)
    .join("\n");

  parts.push(
    `__mods[${id}] = function (module, exports, __req) {\n${src}\n${assigns}\n};`,
  );
}

parts.push(`__req(${JSON.stringify(ENTRY.slice(ROOT.length + 1))});`);

/** `{ a, b as c }` 와 `* as ns` 를 CJS 구조분해로 옮긴다. */
function toCjsBinding(binding) {
  const b = binding.trim();
  const ns = b.match(/^\*\s+as\s+(\w+)$/);
  if (ns !== null) return `${ns[1]}`;
  return b.replace(/\bas\b/g, ":").replace(/\btype\s+/g, "");
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, parts.join("\n\n"));
console.log(
  `모듈 ${order.length}개 → ${OUT} (${(readFileSync(OUT).length / 1024).toFixed(0)}KB)`,
);
