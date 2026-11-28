// Builds another-cli for the target Tauri is building and places it where Tauri bundles sidecar binaries.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const profile = process.argv[2] ?? "release";
const root = path.resolve(import.meta.dir, "..");
const manifest = path.join(root, "Cargo.toml");

function run(command: string, args: string[], capture = false): string {
  const result = spawnSync(command, args, { cwd: root, stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit", encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout ?? "";
}

const host = /^host: (.+)$/m.exec(run("rustc", ["-vV"], true))?.[1].trim();
if (!host) throw new Error("Could not read the host triple from rustc");
const triple = process.env.TAURI_ENV_TARGET_TRIPLE || host;
const crossBuild = triple !== host;

const args = ["build", "-p", "another-cli", "--manifest-path", manifest];
if (profile === "release") args.push("--release");
if (crossBuild) args.push("--target", triple);
run("cargo", args);

const { target_directory: targetDir } = JSON.parse(run("cargo", ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", manifest], true));
const exe = triple.includes("windows") ? ".exe" : "";
const built = path.join(targetDir, ...(crossBuild ? [triple] : []), profile, `another-cli${exe}`);
const binaries = path.join(root, "src-tauri", "binaries");
mkdirSync(binaries, { recursive: true });
copyFileSync(built, path.join(binaries, `another-cli-${triple}${exe}`));
