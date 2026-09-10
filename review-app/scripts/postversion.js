#!/usr/bin/env node
"use strict";

// npm's own git integration for `npm version` only works when package.json
// sits at the repo root (it checks for a literal ".git" inside this app's
// own folder, and BillOCR's ".git" is one level up, at the repo root -- so
// npm silently bumps the version files but never makes the commit/tag it
// normally would). This postversion hook does that commit + annotated tag
// ourselves, scoped to just this app, so `npm version patch` in review-app/
// still behaves exactly like it does in a single-app repo: bump, commit,
// tag, then `git push --follow-tags` publishes it.

const { execFileSync } = require("child_process");
const path = require("path");

const APP_DIR = "review-app";
const TAG_PREFIX = "review-v";

if (process.env.npm_config_git_tag_version === "false") {
  // Honor `npm version --no-git-tag-version`: caller explicitly opted out.
  process.exit(0);
}

const repoRoot = path.resolve(__dirname, "..", "..");
const pkg = require("../package.json");
const tag = `${TAG_PREFIX}${pkg.version}`;

function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", ...opts });
}

// Don't sweep up unrelated staged work into the release commit.
const staged = git(["diff", "--cached", "--name-only"]).trim();
if (staged) {
  console.error(
    `postversion: refusing to continue -- other files are already staged:\n${staged}\n` +
      `Commit or unstage them first, then re-run "npm version".`
  );
  process.exit(1);
}

git(["add", `${APP_DIR}/package.json`, `${APP_DIR}/package-lock.json`]);
git(["commit", "-m", tag], { stdio: "inherit" });
git(["tag", "-a", tag, "-m", tag], { stdio: "inherit" });

console.log(`\nCreated commit + annotated tag ${tag}. Run "git push --follow-tags" to publish.`);
