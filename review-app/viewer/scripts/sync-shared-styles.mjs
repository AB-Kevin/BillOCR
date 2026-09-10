// Copies review-app's own shared design-system stylesheet in before each
// build, so the viewer draws from the exact same tokens (colors, spacing,
// fonts) as the rest of Review instead of a hand-maintained duplicate that
// could drift. Not referenced across directories directly from index.html:
// Vite's dev server restricts serving files outside its project root, and a
// plain copy is simpler and more predictable than configuring around that.
// styles.css itself is never modified -- see its own "stays an exact,
// diffable copy of BillManager's" comment; only copied, verbatim, read-only.
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const reviewRenderer = path.join(here, "..", "..", "renderer");
const dest = path.join(here, "..", "src", "shared");

import { mkdirSync } from "node:fs";
mkdirSync(dest, { recursive: true });
copyFileSync(path.join(reviewRenderer, "styles.css"), path.join(dest, "styles.css"));
// Also app.css -- review-app's OWN additions on top of styles.css (.rv-*
// classes: .rv-badge, .rv-empty, .rv-main, etc.), several of which the
// viewer reuses directly rather than redefining equivalents.
copyFileSync(path.join(reviewRenderer, "app.css"), path.join(dest, "app.css"));
console.log("Synced review-app/renderer/{styles,app}.css -> viewer/src/shared/");
