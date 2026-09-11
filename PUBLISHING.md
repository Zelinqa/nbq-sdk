# Publishing the SDKs

The Python and TypeScript SDKs share one product version. Run `pnpm check:versions`
before every release. Once published, a registry version is immutable and must never be
reused.

The release being prepared is **1.0.0**. Nothing is published until Farouk says so.

## Pre-release checklist

Complete every line before triggering a workflow. Stop at the first failure.

- [ ] Reviewed changes merged into `main` by Farouk (agents never push or merge there).
- [ ] `TypeScript SDK CI` and `Python SDK CI` green on the merge commit, including the
      step that regenerates `typescript/src/generated` and fails on a diff.
- [ ] `pnpm check:versions` passes: `pyproject.toml`, `python/src/nbq/_version.py`,
      `package.json` and `typescript/src/version.ts` all read `1.0.0`.
- [ ] Both live suites green against staging, run manually from `live-tests.yml`
      (`workflow_dispatch`, secrets from the `staging-live` environment):
      `NBQ_LIVE=1 uv run pytest -m live python/tests/live` and `NBQ_LIVE=1 pnpm test:live`.
- [ ] Clean-environment install proofs on the exact artefacts that will be uploaded:
      the wheel imports `nbq` and reports `1.0.0`; the npm tarball resolves under both
      `require("@zelinqa/nbq")` and `import … from "@zelinqa/nbq"` and reports `1.0.0`.
- [ ] Changeset consumed: `pnpm version-packages` ran, `.changeset/*.md` entries are gone,
      and the resulting version files are part of the merged release commit.
- [ ] Root `README.md`, `python/README.md` and `typescript/README.md` describe 1.0.0.
- [ ] No secret in the diff, in a log, in an issue or in a report.
- [ ] **Farouk's explicit go**, after the Codex review.

## Python — PyPI

The package contains working SDK functionality. Do not replace it with an empty placeholder:
PyPI treats name squatting as an invalid project.

Check what the registry already holds before releasing:

```bash
uv run python -c "import urllib.request,json;print(json.load(urllib.request.urlopen('https://pypi.org/pypi/nbq/json'))['info']['version'])"
```

## One-time GitHub setup

In `Zelinqa/nbq-sdk`, create a GitHub Actions environment named `pypi`, add Farouk as a
required reviewer, and restrict deployments to the `main` branch.

## PyPI Trusted Publisher

`nbq` already exists on PyPI at `0.9.0`, so the publisher is configured on the existing
project, not as a pending publisher. While logged in to PyPI, open the project
**Manage → Publishing** page and check that exactly this publisher is present (add it if
the 0.9.0 release was uploaded another way):

| Field | Value |
|---|---|
| PyPI project name | `nbq` |
| GitHub owner | `Zelinqa` |
| GitHub repository | `nbq-sdk` |
| Workflow name | `publish-python-sdk.yml` |
| Environment | `pypi` |

No interactive upload and no API token are needed: the workflow authenticates with OIDC.

## Release

1. Update the version in `pyproject.toml` and `python/src/nbq/_version.py` — or let
   `pnpm version-packages` do it, which keeps both languages in sync.
2. Merge the reviewed release changes into `main`. Only Farouk performs this merge.
3. Run **Publish Python SDK to PyPI** from `main` with confirmation `publish-nbq`:

   ```bash
   gh workflow run publish-python-sdk.yml -f confirm=publish-nbq --ref main
   ```

   The workflow refuses to run from any other ref or with any other confirmation string.
4. Approve the protected `pypi` environment deployment.
5. Verify <https://pypi.org/project/nbq/> and install the wheel in a clean environment:

   ```bash
   uv venv /tmp/nbq-py-clean && /tmp/nbq-py-clean/bin/pip install nbq==1.0.0
   /tmp/nbq-py-clean/bin/python -c "import nbq; print(nbq.__version__)"
   ```
6. Add at least one additional trusted Zelinqa owner to the PyPI project.

## TypeScript — npm

The public package is `@zelinqa/nbq`. Local development, builds, tests, and packaging use
pnpm. The release workflow uses the npm CLI only for the final registry operation because
npm Trusted Publishing OIDC is implemented by npm CLI 11.5.1 or newer.

Check what the registry already holds:

```bash
npm view @zelinqa/nbq version
```

`@zelinqa/nbq` is already published at `0.9.0`, so **the Trusted Publisher route applies to
1.0.0 and the interactive step below is not needed.** Go straight to
[Releases](#releases). The interactive procedure is kept only for the case of a package
that does not exist on npm yet, because npm allows a trusted publisher to be configured
only for an existing package.

### First publication of a package that does not exist yet

Skip this section for `@zelinqa/nbq`.

1. Create an npm user account, verify its email, and enable account-level 2FA.
2. Create the free public npm organization `zelinqa`.
3. From a clean checkout of reviewed `main`, run `pnpm install --frozen-lockfile`,
   `pnpm check`, `pnpm build`, and `pnpm pack --pack-destination package-artifacts`.
4. Farouk authenticates interactively with npm and publishes
   `package-artifacts/zelinqa-nbq-1.0.0.tgz` as a public package. Never paste credentials,
   OTPs, or registry tokens into chat or commit them to the repository.

### One-time Trusted Publisher setup

In `Zelinqa/nbq-sdk`, create a GitHub Actions environment named `npm`, add Farouk as a
required reviewer, and restrict deployments to the `main` branch.

Then open the `@zelinqa/nbq` package settings on npm and configure exactly:

| Field | Value |
|---|---|
| Provider | GitHub Actions |
| GitHub organization or user | `Zelinqa` |
| Repository | `nbq-sdk` |
| Workflow filename | `publish-typescript-sdk.yml` |
| Environment | `npm` |
| Allowed action | `npm publish` |

After one successful OIDC release, set npm **Publishing access** to **Require two-factor
authentication and disallow tokens**, then revoke any temporary publication token if one was
created for an earlier release.

### Releases

1. Add a Changeset with `pnpm changeset`.
2. Run `pnpm version-packages`; this synchronizes the Python and TypeScript version files.
3. Merge the reviewed release changes into `main`. Only Farouk performs this merge.
4. Run **Publish TypeScript SDK to npm** from `main` with confirmation
   `publish-zelinqa-nbq`:

   ```bash
   gh workflow run publish-typescript-sdk.yml -f confirm=publish-zelinqa-nbq --ref main
   ```

   The workflow refuses to run from any other ref or with any other confirmation string.
5. Approve the protected `npm` environment deployment.
6. Verify the npm provenance and install the package in a clean Node.js project:

   ```bash
   mkdir -p /tmp/nbq-ts-clean && cd /tmp/nbq-ts-clean && npm init -y >/dev/null
   npm install @zelinqa/nbq@1.0.0
   node -e "console.log(require('@zelinqa/nbq').VERSION)"
   node --input-type=module -e "import {VERSION} from '@zelinqa/nbq'; console.log(VERSION)"
   ```

## After both releases

- Announce the versions and the removal of the 0.9 SDK routes in the product changelog.
- Keep the `openapi/nbq-v1.openapi.yaml` snapshot that produced the release: it is the
  contract the published SDKs were generated from.
