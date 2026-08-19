import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]


def load_devpy():
    spec = importlib.util.spec_from_file_location(
        "devpy_build_identity_under_test", ROOT / "dev.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BuildIdentityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dev = load_devpy()

    def test_git_build_identity_tracks_clean_and_dirty_checkout(self):
        clean = CompletedProcess([], 0, stdout="0123456789ab\n", stderr="")
        dirty = CompletedProcess([], 0, stdout=" M dev.py\n", stderr="")
        with mock.patch.object(
            self.dev.subprocess, "run", side_effect=[clean, dirty]
        ):
            self.assertEqual(
                self.dev._git_build_identity(), "0123456789ab-dirty"
            )

    def test_git_build_identity_is_unknown_when_head_is_unavailable(self):
        missing = CompletedProcess([], 128, stdout="", stderr="not a repository")
        with mock.patch.object(
            self.dev.subprocess, "run", return_value=missing
        ) as run:
            self.assertEqual(self.dev._git_build_identity(), "unknown")
        run.assert_called_once()

    def test_git_build_identity_is_unknown_when_dirty_state_is_unavailable(self):
        clean = CompletedProcess([], 0, stdout="0123456789ab\n", stderr="")
        failed_status = CompletedProcess([], 128, stdout="", stderr="status failed")
        with mock.patch.object(
            self.dev.subprocess, "run", side_effect=[clean, failed_status]
        ):
            self.assertEqual(self.dev._git_build_identity(), "unknown")

    def test_build_rust_supplies_stable_identity_to_cargo(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            ui_dir = Path(temp_dir) / "ui"
            ui_dir.mkdir()
            with (
                mock.patch.object(self.dev, "UI_DIR", ui_dir),
                mock.patch.object(
                    self.dev,
                    "_git_build_identity",
                    return_value="0123456789ab-dirty",
                ),
                mock.patch.object(self.dev, "_run_cargo_build") as run_build,
                mock.patch.dict(os.environ, {"PRESERVED": "yes"}, clear=True),
            ):
                self.dev.build_rust(release=True)

        run_build.assert_called_once()
        args, cwd, profile = run_build.call_args.args
        env = run_build.call_args.kwargs["env"]
        self.assertEqual(args, ["cargo", "build", "--release"])
        self.assertEqual(cwd, self.dev.ROOT)
        self.assertEqual(profile, "release")
        self.assertEqual(env["PRESERVED"], "yes")
        self.assertEqual(
            env[self.dev._BUILD_GIT_SHA_ENV], "0123456789ab-dirty"
        )


if __name__ == "__main__":
    unittest.main()
