import importlib.util
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]


def load_devpy():
    spec = importlib.util.spec_from_file_location("devpy_up_under_test", ROOT / "dev.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class UpCommandTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dev = load_devpy()

    def _run_up(self, phoenix_pid, vite_pid, *, backend_matches):
        dev = self.dev
        call_order = []

        def get_pid(path):
            if path == dev.PHOENIX_PID_FILE:
                return phoenix_pid
            if path == dev.VITE_PID_FILE:
                return vite_pid
            raise AssertionError(f"unexpected pid path: {path}")

        patchers = {
            "reap_orphans": mock.patch.object(dev, "reap_orphans", return_value=False),
            "get_default_ports": mock.patch.object(
                dev, "get_default_ports", return_value=(8100, 8101)
            ),
            "get_port_offsets": mock.patch.object(
                dev, "get_port_offsets", return_value=(0, 0)
            ),
            "get_worktree_hash": mock.patch.object(
                dev, "get_worktree_hash", return_value="test"
            ),
            "get_pid": mock.patch.object(dev, "get_pid", side_effect=get_pid),
            "select_dev_ports": mock.patch.object(
                dev, "select_dev_ports", return_value=(8100, 8101)
            ),
            "resolved_env": mock.patch.object(
                dev, "_resolved_phoenix_env", return_value={}
            ),
            "matches": mock.patch.object(
                dev, "_running_phoenix_matches", return_value=backend_matches
            ),
            "stop_process": mock.patch.object(
                dev, "stop_process", side_effect=lambda *_: call_order.append("stop")
            ),
            "sleep": mock.patch.object(dev.time, "sleep"),
            "build_rust": mock.patch.object(
                dev, "build_rust", side_effect=lambda **_: call_order.append("build")
            ),
            "start_phoenix": mock.patch.object(dev, "start_phoenix", return_value=False),
            "start_vite": mock.patch.object(dev, "start_vite", return_value=False),
        }
        entered = {name: patcher.start() for name, patcher in patchers.items()}
        self.addCleanup(
            lambda: [patcher.stop() for patcher in reversed(tuple(patchers.values()))]
        )
        dev.cmd_up(no_seed=True)
        return {**entered, "call_order": call_order}

    def test_running_backend_matches_only_exact_healthy_scheme(self):
        with mock.patch.object(self.dev, "_probe_phoenix_scheme") as probe:
            probe.return_value = "http"
            self.assertTrue(self.dev._running_phoenix_matches(8100, False))
            self.assertFalse(self.dev._running_phoenix_matches(8100, True))

            probe.return_value = "https"
            self.assertTrue(self.dev._running_phoenix_matches(8100, True))
            self.assertFalse(self.dev._running_phoenix_matches(8100, False))

            probe.return_value = None
            self.assertFalse(self.dev._running_phoenix_matches(8100, False))
            self.assertFalse(self.dev._running_phoenix_matches(8100, True))

    def test_reused_healthy_backend_skips_build_and_keeps_vite_startup(self):
        calls = self._run_up(phoenix_pid=101, vite_pid=None, backend_matches=True)

        calls["build_rust"].assert_not_called()
        calls["stop_process"].assert_not_called()
        calls["start_phoenix"].assert_called_once_with(port=8100, tls=False)
        calls["start_vite"].assert_called_once_with(
            port=8101, phoenix_port=8100, phoenix_tls=False
        )

    def test_absent_backend_builds_before_startup(self):
        calls = self._run_up(phoenix_pid=None, vite_pid=None, backend_matches=False)

        calls["build_rust"].assert_called_once_with(release=True)
        calls["matches"].assert_not_called()
        calls["start_phoenix"].assert_called_once_with(port=8100, tls=False)
        calls["start_vite"].assert_called_once()

    def test_unhealthy_backend_is_rebuilt_instead_of_reused(self):
        calls = self._run_up(phoenix_pid=101, vite_pid=202, backend_matches=False)

        calls["stop_process"].assert_called_once_with(
            self.dev.PHOENIX_PID_FILE, "Phoenix"
        )
        calls["sleep"].assert_called_once_with(0.5)
        calls["build_rust"].assert_called_once_with(release=True)
        calls["matches"].assert_called_once_with(8100, False)
        calls["start_phoenix"].assert_called_once_with(port=8100, tls=False)
        self.assertEqual(calls["call_order"], ["stop", "build"])


if __name__ == "__main__":
    unittest.main()
