# BillOCR

Two desktop apps that replace the old BillOCR terminal scripts with point-and-click UIs, for the two machines the claims pipeline actually runs on:

- **[BillOCR Intake](intake-app/)** — installed on the dedicated OCR machine. Runs the CMS-1500/UB-04 extraction watcher continuously in the background (Start/Stop button, system tray, launch-at-login).
- **[BillOCR Review](review-app/)** — installed on the approval machine. Lets a person review/edit/approve extracted claims; approving a claim builds its finished 837 (saved as `.txt`) immediately.

The two apps never talk to each other directly — they only share a **workspace folder** over the network (see below). Both bundle a copy of the Python pipeline (in [`pipeline/`](pipeline/)) so this one repo is everything you need; you don't need the old BillOCR repo at all.

## How the pieces fit together

```
   OCR machine (Windows, always on)              Approval machine (yours)
  ┌───────────────────────────────┐             ┌───────────────────────────────┐
  │  BillOCR Intake                │             │  BillOCR Review                │
  │  watches incoming_1500/,       │   network   │  reads pending_review/,        │
  │  incoming_ub04/, writes to     │───share────▶│  writes approved/, output_837/ │
  │  pending_review/                │             │  and org_config.json           │
  └───────────────────────────────┘             └───────────────────────────────┘
              \_______________________ one shared workspace folder ______________________/
```

The workspace folder — `incoming_1500/`, `incoming_ub04/`, `pending_review/` (+ `images/`), `approved/`, `output_837/`, `org_config.json`, `control_numbers.json` — physically lives on (or near) the OCR machine. Share it over the network (e.g. Windows file sharing/SMB) and point BillOCR Review's workspace setting at that share (a UNC path like `\\OCR-MACHINE\BillOCR` or a mapped drive letter). Setting up the actual share/permissions is outside either app — a one-time step on your network.

**Known limitation:** this assumes one person approves claims at a time. There's no locking around `control_numbers.json` or the shared files, so two people approving simultaneously could race. Fine for a single reviewer; would need real coordination if that ever changes.

## Prerequisites (per machine)

Both machines still need the same underlying local-LLM setup the old repo documented — this UI doesn't remove that, it just means you never type the commands yourself:

- **OCR machine**: [Ollama](https://ollama.com) running, a vision-capable `-instruct` tagged Qwen model pulled (e.g. `ollama pull qwen3-vl:8b-instruct`), Python 3.9+, and `pip install -r pipeline/requirements.txt` (just the `ollama` package, plus `pip install Pillow` if you want to use the max-image-dimension setting).
- **Approval machine**: Python 3.9+ only. `pipeline/x12_837.py` (what actually builds the 837) has zero third-party dependencies — nothing to `pip install` there.

Each app has a "Python path" setting (defaults to `python3` on Mac/Linux, `python` on Windows) in case `python3`/`python` isn't the right command on a given machine.

## Flagging likely misreads

Two independent, complementary mechanisms flag fields worth double-checking, shown amber in Review (distinct from the red "missing required field" highlighting, which is about presence, not confidence):

- **Verification passes** (Intake setting, default 3 total): after the primary read of an image, Intake resamples the same image that many more times at a higher temperature and flags any field where a resample disagrees with the primary read. Set to `1` to turn this off (today's single-read behavior, no extra cost); higher catches more but adds that many more model calls per image, so it's proportionally slower. `pipeline/field_validation.py`'s `values_equivalent()` tolerates pure formatting differences (`"150.00"` vs `150.0`) so those don't produce noise.
- **Deterministic validation** (`pipeline/field_validation.py`, always on, no extra inference cost): NPI check-digit validation (the real CMS Luhn algorithm, not just a length check), ICD-10/CPT/HCPCS/ZIP/tax-ID shape checks, date sanity, and total-charge-vs-sum-of-line-items arithmetic. Shape checks only — there's no real ICD-10/CPT code-list lookup here, that would need the actual versioned code sets.

Review recomputes the validation flags (not the pass-disagreement ones, which need re-running the model) every time you save an edited claim, via `pipeline/validate_fields.py` — editing a flagged field's value clears its disagreement flag and re-checks it against the validators fresh.

## Running each app

```
cd intake-app && npm install && npm start
cd review-app && npm install && npm start
```

First run of either app: choose the workspace folder (local path on the OCR machine; the network share/mapped drive on the approval machine). BillOCR Review seeds `org_config.json` from the template automatically if the workspace doesn't have one yet — fill in your real values under Organization Settings before approving anything for real.

## Building an installer

Each app builds independently (matching [BillManager](https://github.com/AB-Kevin/BillManager)'s setup):

```
npm run dist        # Windows NSIS installer
npm run dist:mac     # Mac .dmg/.zip
```

Both apps bundle their slice of `pipeline/` as `extraResources`, so the installed app carries the Python scripts with it — Python itself and its (minimal, per above) dependencies still need to be on the target machine.

**Releases**: automated via [`.github/workflows/release-intake.yml`](.github/workflows/release-intake.yml) and [`release-review.yml`](.github/workflows/release-review.yml). Since both apps publish to this one repo, each uses its own tag namespace so they can never collide:

```
cd intake-app && npm version 1.0.1 && cd ..
git commit -am "Intake v1.0.1"
git tag intake-v1.0.1 && git push origin main intake-v1.0.1
```

(swap `intake` for `review` for the other app). Each workflow builds Windows + Mac and uploads both to a release named after its own prefixed tag.

## Repo layout

```
pipeline/          Shared Python pipeline (extraction, 837 building) — see comments in each file
intake-app/        BillOCR Intake — Electron app
review-app/        BillOCR Review — Electron app
```

`pipeline/` also still has `build_837.py` (the original folder-watcher build script) even though neither app uses it — Review calls `pipeline/build_one.py` instead (a one-shot single-claim build, so approving is immediate with no background process). `build_837.py`/`extract_claim_fields.py` remain valid to run from a terminal directly if you ever need to, same as the old repo.

## Design system

Both apps' `renderer/styles.css` are the Anabaptist Brotherhood design system used by [BillManager](https://github.com/AB-Kevin/BillManager) — same tokens, same component classes, copied wholesale so they stay visually consistent with it.
