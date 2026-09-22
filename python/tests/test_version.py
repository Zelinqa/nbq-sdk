from importlib.metadata import version

import zelinqa


def test_package_and_module_versions_match() -> None:
    assert version("zelinqa") == zelinqa.__version__
