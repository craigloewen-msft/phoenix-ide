import importlib.util
import os
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]


def load_devpy():
    spec = importlib.util.spec_from_file_location("devpy_accel_under_test", ROOT / "dev.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class AdvisoryTests(unittest.TestCase):
    def setUp(self):
        self.dev = load_devpy()

    def advise(self, *, nextest, compiler_cache, linker_configured, installed=()):
        with mock.patch.object(
            self.dev.shutil,
            "which",
            side_effect=lambda name: f"/bin/{name}" if name in installed else None,
        ):
            return self.dev._accelerator_advisories(
                nextest=nextest,
                compiler_cache=compiler_cache,
                linker_configured=linker_configured,
            )

    def test_fully_accelerated_run_is_silent(self):
        self.assertEqual([], self.advise(
            nextest=True, compiler_cache="sccache", linker_configured=True,
        ))

    def test_missing_nextest_names_the_install_command(self):
        advisories = self.advise(
            nextest=False, compiler_cache="sccache", linker_configured=True,
        )
        self.assertEqual(1, len(advisories))
        self.assertIn("cargo-nextest", advisories[0].what)
        self.assertIn("cargo install cargo-nextest", advisories[0].install)

    def test_missing_compiler_cache_is_reported(self):
        advisories = self.advise(
            nextest=True, compiler_cache="none", linker_configured=True,
        )
        self.assertEqual(1, len(advisories))
        self.assertIn("compiler cache", advisories[0].what)

    def test_unprobed_accelerators_are_not_reported_as_missing(self):
        """No cargo lane ran, so nothing was probed and nothing is known absent."""
        self.assertEqual([], self.advise(
            nextest=None, compiler_cache=None, linker_configured=True,
        ))

    def test_installed_but_unused_linker_suggests_rerunning_check(self):
        advisories = self.advise(
            nextest=True, compiler_cache="sccache", linker_configured=False,
            installed=("ld.lld",),
        )
        self.assertEqual(1, len(advisories))
        self.assertIn("installed but unused", advisories[0].what)

    def test_absent_linker_suggests_installing_one(self):
        advisories = self.advise(
            nextest=True, compiler_cache="sccache", linker_configured=False,
        )
        self.assertEqual(1, len(advisories))
        self.assertIn("install mold or lld", advisories[0].install)

    def test_every_advisory_carries_a_cost_and_a_fix(self):
        advisories = self.advise(
            nextest=False, compiler_cache="none", linker_configured=False,
        )
        self.assertEqual(3, len(advisories))
        for item in advisories:
            self.assertTrue(item.what.strip())
            self.assertTrue(item.cost.strip())
            self.assertTrue(item.install.strip())


class LinkerConfigTests(unittest.TestCase):
    def setUp(self):
        self.dev = load_devpy()

    def configure(self, *, env=None, installed=()):
        env = {} if env is None else env
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(
            self.dev.shutil,
            "which",
            side_effect=lambda name: f"/bin/{name}" if name in installed else None,
        ):
            return self.dev._configure_linker(), os.environ.copy()

    def test_prefers_mold_over_lld(self):
        configured, env = self.configure(installed=("mold", "ld.lld"))
        self.assertTrue(configured)
        self.assertEqual("-Clink-arg=-fuse-ld=mold", env["RUSTFLAGS"])

    def test_falls_back_to_lld(self):
        configured, env = self.configure(installed=("ld.lld",))
        self.assertTrue(configured)
        self.assertEqual("-Clink-arg=-fuse-ld=lld", env["RUSTFLAGS"])

    def test_no_linker_installed_leaves_rustflags_unset(self):
        configured, env = self.configure()
        self.assertFalse(configured)
        self.assertNotIn("RUSTFLAGS", env)

    def test_explicit_rustflags_is_never_overridden(self):
        configured, env = self.configure(
            env={"RUSTFLAGS": "-Cdebuginfo=0"}, installed=("mold",),
        )
        self.assertFalse(configured)
        self.assertEqual("-Cdebuginfo=0", env["RUSTFLAGS"])

    def test_opt_out_is_honored(self):
        configured, env = self.configure(
            env={"PHOENIX_NO_LINKER_CONFIG": "1"}, installed=("mold",),
        )
        self.assertFalse(configured)
        self.assertNotIn("RUSTFLAGS", env)


if __name__ == "__main__":
    unittest.main()
