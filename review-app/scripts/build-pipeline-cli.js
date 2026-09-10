#!/usr/bin/env node
// Freezes pipeline/review_cli.py into a standalone, no-Python-required
// executable via PyInstaller, staged at vendor/pipeline-cli/ for
// electron-builder's extraResources to pick up (see package.json's
// build.extraResources and main.js's PIPELINE_CLI_PATH).
//
// Must run on the SAME OS as the eventual install target -- PyInstaller
// doesn't cross-compile. On this machine that means it only produces a
// build usable by `npm run dist:mac` (see that script's predist:mac hook
// below); `npm run dist` (Windows) needs this run ON Windows instead --
// release-review.yml's own windows-latest/macos-latest CI runners each run
// this same script for their own platform before packaging.
//
// Needs a real Python only to BUILD this app -- never to run the packaged
// result, which is the whole point (see main.js's PIPELINE_CLI_PATH
// comment). Uses a disposable venv so it doesn't depend on (or pollute)
// whatever's already on PATH beyond a bare interpreter.
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PIPELINE_DIR = path.join(REPO_ROOT, "pipeline");
const OUT_DIR = path.join(__dirname, "..", "vendor", "pipeline-cli");
const BINARY_NAME = "billocr-review-pipeline";

function findPython() {
  for (const candidate of ["python3", "python"]) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // try the next one
    }
  }
  throw new Error(
    "No Python interpreter found on PATH (python3/python) -- needed only to BUILD this app; installed users never need one."
  );
}

const python = findPython();
const venvDir = fs.mkdtempSync(path.join(os.tmpdir(), "billocr-pyinstaller-venv-"));
const venvPython = process.platform === "win32" ? path.join(venvDir, "Scripts", "python.exe") : path.join(venvDir, "bin", "python3");
const venvPyinstaller =
  process.platform === "win32" ? path.join(venvDir, "Scripts", "pyinstaller.exe") : path.join(venvDir, "bin", "pyinstaller");

try {
  console.log(`Building ${BINARY_NAME} for ${process.platform} (build-time only -- installed users won't need Python)...`);
  execFileSync(python, ["-m", "venv", venvDir], { stdio: "inherit" });
  execFileSync(venvPython, ["-m", "pip", "install", "--quiet", "pyinstaller"], { stdio: "inherit" });

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "billocr-pyinstaller-work-"));
  execFileSync(
    venvPyinstaller,
    ["--onefile", "--name", BINARY_NAME, "--distpath", OUT_DIR, "--workpath", workDir, "--specpath", workDir, "review_cli.py"],
    { cwd: PIPELINE_DIR, stdio: "inherit" }
  );
  fs.rmSync(workDir, { recursive: true, force: true });
  console.log(`Built ${path.join(OUT_DIR, BINARY_NAME)}`);
} finally {
  fs.rmSync(venvDir, { recursive: true, force: true });
}
