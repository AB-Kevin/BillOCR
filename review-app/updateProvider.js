// BillOCR Review — custom electron-updater provider.
//
// electron-updater's built-in GitHub provider finds "the latest release" by
// hitting GitHub's own /releases/latest endpoint -- a single flag per
// REPOSITORY, not per app. Since Intake and Review publish to the same
// GitHub repo under their own tag prefixes ("intake-v*"/"review-v*"), that
// endpoint reflects whichever app released most recently, not necessarily
// this one (see the memory note billocr-shared-latest-release-bug). Using
// the stock provider as-is would mean Review's update check could offer
// Intake's version, or vice versa.
//
// This provider instead lists releases via the GitHub REST API, keeps only
// tags starting with TAG_PREFIX, and picks the newest by semver itself.
// Everything downstream -- the channel file (latest.yml/latest-mac.yml),
// asset checksums, differential-update blockmaps -- works exactly like the
// stock provider once the right tag is found, because GitHub's per-tag
// asset URLs (/releases/download/<tag>/<file>) are always stable regardless
// of which release currently holds the repo's "Latest" badge.
//
// Deliberately doesn't reach into electron-updater's own provider internals
// (e.g. requiring its GitHubProvider.js directly) -- only its public
// `Provider` base class, plus plain fetch() and js-yaml/semver (both
// already real dependencies of electron-updater, so already installed).
// That's a smaller surface to break across an electron-updater upgrade.

"use strict";

const { Provider } = require("electron-updater");
const semver = require("semver");
const yaml = require("js-yaml");

const OWNER = "AB-Kevin";
const REPO = "BillOCR";
const TAG_PREFIX = "review-v";
const USER_AGENT = "BillOCR-Review-Updater";
const DOWNLOAD_BASE = `https://github.com/${OWNER}/${REPO}/releases/download`;

async function httpGet(url, headers, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

class PrefixedGitHubProvider extends Provider {
  constructor(options, updater, runtimeOptions) {
    super({
      ...runtimeOptions,
      // GitHub Releases assets are S3-backed and don't reliably support
      // multi-range requests -- same reason electron-updater's own
      // GitHubProvider forces this off.
      isUseMultipleRangeRequest: false,
    });
    this.updater = updater;
  }

  get channel() {
    const result = this.updater.channel || "latest";
    return this.getCustomChannelName(result);
  }

  async listMatchingReleases() {
    const res = await httpGet(`https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=100`, {
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
    });
    const releases = await res.json();
    const allowPrerelease = !!this.updater.allowPrerelease;
    return releases
      .filter((r) => !r.draft && (allowPrerelease || !r.prerelease))
      .filter((r) => typeof r.tag_name === "string" && r.tag_name.startsWith(TAG_PREFIX))
      .map((r) => ({ release: r, version: r.tag_name.slice(TAG_PREFIX.length) }))
      .filter((r) => semver.valid(r.version));
  }

  async getLatestVersion() {
    const candidates = await this.listMatchingReleases();
    if (candidates.length === 0) {
      throw new Error(`No published "${TAG_PREFIX}*" releases found on GitHub`);
    }
    candidates.sort((a, b) => semver.rcompare(a.version, b.version));
    const best = candidates[0].release;
    const tag = best.tag_name;

    const channelFile = `${this.channel}.yml`;
    const channelFileUrl = `${DOWNLOAD_BASE}/${tag}/${channelFile}`;
    let rawData;
    try {
      const res = await httpGet(channelFileUrl, { Accept: "*/*" });
      rawData = await res.text();
    } catch (e) {
      throw new Error(`Cannot find ${channelFile} in release ${tag} (${channelFileUrl}): ${e.message}`);
    }
    const info = yaml.load(rawData);
    // Kept around for resolveFiles() -- see its own comment for why this
    // matters: the real, GitHub-confirmed asset list beats reconstructing
    // a URL from the filename latest.yml itself claims.
    return { tag, releaseName: best.name || tag, assets: best.assets || [], ...info };
  }

  // Deliberately does NOT reconstruct a download URL from latest.yml's own
  // filename the way the stock GitHubProvider does (electron-builder's own
  // "-" space-replacement convention). That convention doesn't actually
  // match reality here: our release workflow uploads the built .exe/.dmg
  // via a plain `gh release upload` (a raw GitHub REST call), and GitHub's
  // asset-upload endpoint renames spaces in the filename to PERIODS, not
  // dashes -- e.g. the local build's "BillOCR Review Setup 0.2.2.exe"
  // really ends up stored as "BillOCR.Review.Setup.0.2.2.exe", while
  // latest.yml still says "BillOCR-Review-Setup-0.2.2.exe". Reconstructing
  // the dash version 404s. Matching against the release's own `assets`
  // list (already fetched in getLatestVersion, since it's part of the same
  // GitHub API response used to find the release) and using THAT asset's
  // real `browser_download_url` sidesteps needing to know which
  // substitution GitHub applies at all, and survives it changing again.
  resolveFiles(updateInfo) {
    const files =
      updateInfo.files && updateInfo.files.length
        ? updateInfo.files
        : [{ url: updateInfo.path, sha512: updateInfo.sha512, sha2: updateInfo.sha2 }];
    const assets = updateInfo.assets || [];
    const normalize = (name) => String(name).toLowerCase().replace(/[ ._-]+/g, "-");
    return files.map((fileInfo) => {
      const wanted = normalize(fileInfo.url);
      const match = assets.find((a) => normalize(a.name) === wanted);
      const url = match
        ? new URL(match.browser_download_url)
        : new URL(`${DOWNLOAD_BASE}/${updateInfo.tag}/${String(fileInfo.url).replace(/ /g, "-")}`); // last-resort fallback if the asset list is ever unavailable/stale
      return { url, info: fileInfo };
    });
  }
}

module.exports = { PrefixedGitHubProvider };
