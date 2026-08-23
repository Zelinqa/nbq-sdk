# Publishing the SDKs

The Python and TypeScript SDKs use the same product version. Run `pnpm check:versions`
before every release. Once published, a registry version is immutable and must never be
reused.

## Python — PyPI

The package contains working SDK functionality. Do not replace it with an empty placeholder:
PyPI treats name squatting as an invalid project.

## One-time GitHub setup

In `Zelinqa/nbq-sdk`, create a GitHub Actions environment named `pypi`, add Farouk as a
required reviewer, and restrict deployments to the `main` branch.

## PyPI Trusted Publisher

While logged in to PyPI, open **Account settings → Publishing → Add a new pending publisher**
and enter exactly:

| Field | Value |
|---|---|
| PyPI project name | `nbq` |
| GitHub owner | `Zelinqa` |
| GitHub repository | `nbq-sdk` |
| Workflow name | `publish-python-sdk.yml` |
| Environment | `pypi` |

A pending publisher does **not** reserve the name. The first successful upload creates the
PyPI project and claims it.

## Release

1. Update the version in `pyproject.toml` and `python/src/nbq/_version.py`.
2. Merge the reviewed release changes into `main`. Only Farouk performs this merge.
3. Run **Publish Python SDK to PyPI** from `main` with confirmation `publish-nbq`.
4. Approve the protected `pypi` environment deployment.
5. Verify <https://pypi.org/project/nbq/> and install the wheel in a clean environment.
6. Add at least one additional trusted Zelinqa owner to the PyPI project.

## TypeScript — npm

The public package is `@zelinqa/nbq`. Local development, builds, tests, and packaging use
pnpm. The release workflow uses the npm CLI only for the final registry operation because
npm Trusted Publishing OIDC is implemented by npm CLI 11.5.1 or newer.

### First publication only

1. Create an npm user account, verify its email, and enable account-level 2FA.
2. Create the free public npm organization `zelinqa`.
3. From a clean checkout of reviewed `main`, run `pnpm install --frozen-lockfile`,
   `pnpm check`, `pnpm build`, and `pnpm pack --pack-destination package-artifacts`.
4. Farouk authenticates interactively with npm and publishes
   `package-artifacts/zelinqa-nbq-0.9.0.tgz` as a public package. Never paste credentials,
   OTPs, or registry tokens into chat or commit them to the repository.

The first interactive publication is necessary because npm only allows a trusted publisher
to be configured for a package that already exists.

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
created for the first release.

### Subsequent releases

1. Add a Changeset with `pnpm changeset`.
2. Run `pnpm version-packages`; this synchronizes the Python and TypeScript version files.
3. Merge the reviewed release changes into `main`. Only Farouk performs this merge.
4. Run **Publish TypeScript SDK to npm** from `main` with confirmation
   `publish-zelinqa-nbq`.
5. Approve the protected `npm` environment deployment.
6. Verify the npm provenance and install the package in a clean Node.js project.
