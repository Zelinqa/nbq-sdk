from importlib.metadata import version

import nbq


def test_package_and_module_versions_match() -> None:
    assert version("nbq") == nbq.__version__
