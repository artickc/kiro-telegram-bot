# Release checklist

A release ships a **batch of merged pull requests** as one versioned tag. The
heavy lifting (zip + notes + publish) is automated by
`.github/workflows/release.yml`; this checklist covers the manual steps.

## 1. Pre-flight (on `main`)

- [ ] All intended PRs for this batch are **merged into `main`**.
- [ ] `git checkout main && git pull` — local `main` matches origin.
- [ ] `npm ci && npm run typecheck` passes with no errors.
- [ ] Manual smoke test where relevant (`npm start`, basic Telegram round-trip).

## 2. Changelog & version

- [ ] Add a new `## [X.Y.Z] - YYYY-MM-DD` section to `CHANGELOG.md` with the
      user-facing features/fixes (this becomes the GitHub Release notes).
- [ ] Add the matching link reference at the bottom of `CHANGELOG.md`.
- [ ] Choose the bump per SemVer: `patch` (fixes), `minor` (features),
      `major` (breaking).

## 3. Tag & publish

```bash
npm version minor          # bumps package.json, commits, creates the v* tag
git push --follow-tags     # pushing the tag triggers the Release workflow
```

- [ ] Watch the **Release** workflow in the Actions tab finish green.
- [ ] Confirm the GitHub Release exists with:
  - [ ] the correct title (`vX.Y.Z`),
  - [ ] notes matching the CHANGELOG section,
  - [ ] the attached `kiro-telegram-bot-X.Y.Z.zip`,
  - [ ] GitHub's auto-generated Source code archives.

## 4. Post-release

- [ ] Announce / update any docs that reference the version.
- [ ] Open the next batch of feature branches off the new `main`.
