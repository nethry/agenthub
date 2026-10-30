// One version for the whole app. `package.json` is the source of truth;
// `tauri.conf.json` reads it (`"version": "../package.json"`), and this script
// keeps the Cargo manifests and the sidecar package in step.
//
//   node scripts/set-version.mjs 0.2.0    set everywhere
//   node scripts/set-version.mjs --check  fail when the files disagree (CI)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const path = (p) => root + p;

const files = [
  { file: "package.json", kind: "json" },
  { file: "sidecar/package.json", kind: "json" },
  { file: "src-tauri/Cargo.toml", kind: "toml" },
];

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function read({ file, kind }) {
  const text = readFileSync(path(file), "utf8");
  if (kind === "json") return { text, version: JSON.parse(text).version };
  const m = text.match(/^version = "([^"]+)"$/m);
  return { text, version: m?.[1] };
}

function write({ file, kind }, version) {
  const { text } = read({ file, kind });
  const next =
    kind === "json"
      ? text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`)
      : text.replace(/^version = "[^"]+"$/m, `version = "${version}"`);
  writeFileSync(path(file), next);
}

/** `tauri.conf.json` must read the version from package.json, never carry its own. */
function confReadsPackage() {
  const conf = JSON.parse(readFileSync(path("src-tauri/tauri.conf.json"), "utf8"));
  return conf.version === "../package.json";
}

const arg = process.argv[2];
if (arg === "--check") {
  const seen = files.map((f) => ({ file: f.file, version: read(f).version }));
  const source = seen[0].version;
  const bad = seen.filter((s) => s.version !== source);
  let failed = false;
  if (bad.length) {
    console.error(`Versions differ from package.json (${source}):`);
    for (const b of bad) console.error(`  ${b.file}: ${b.version}`);
    failed = true;
  }
  if (!confReadsPackage()) {
    console.error('src-tauri/tauri.conf.json must have "version": "../package.json".');
    failed = true;
  }
  if (failed) process.exit(1);
  console.log(`All versions are ${source}.`);
} else if (arg && SEMVER.test(arg)) {
  for (const f of files) write(f, arg);
  console.log(`Set version ${arg} in ${files.map((f) => f.file).join(", ")}. Cargo.lock updates on the next build.`);
} else {
  console.error("Usage: node scripts/set-version.mjs <x.y.z> | --check");
  process.exit(2);
}
