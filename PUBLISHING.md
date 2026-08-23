# Publishing the Python SDK

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

Never delete and reuse a published version. Increment the version for every subsequent upload.
