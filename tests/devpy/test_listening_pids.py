import importlib.util
import subprocess
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]

SS_OUTPUT = (
    'LISTEN 0 128  127.0.0.1:8016 0.0.0.0:* users:(("phoenix_ide",pid=18703,fd=17))\n'
    'LISTEN 0 511  127.0.0.1:8040 0.0.0.0:* users:(("MainThread",pid=30720,fd=22))\n'
    'LISTEN 0 4096   127.0.0.54:53 0.0.0.0:* users:(("systemd-resolve",pid=411,fd=18))\n'
    'LISTEN 0 511        [::1]:8040    [::]:* users:(("MainThread",pid=30720,fd=23))\n'
)


def load_devpy():
    spec = importlib.util.spec_from_file_location("devpy_listening_pids_under_test", ROOT / "dev.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class ListeningPidsTests(unittest.TestCase):
    """`_listening_pids` must not report "nothing is listening" just because a
    probe tool is missing: `_wait_for_port` reads an empty list as "our server
    never bound" and aborts a healthy launch. `lsof` is absent from many
    minimal Linux images, so the `ss` fallback has to carry that case.
    """

    def setUp(self):
        self.dev = load_devpy()

    def run_cmd(self, *, lsof=None, ss=None):
        """Fake `subprocess.run`, raising FileNotFoundError for absent tools."""

        def fake_run(argv, **_kwargs):
            tool = argv[0]
            out = {"lsof": lsof, "ss": ss}.get(tool)
            if out is None:
                raise FileNotFoundError(tool)
            return subprocess.CompletedProcess(argv, 0, stdout=out, stderr="")

        return mock.patch.object(self.dev.subprocess, "run", side_effect=fake_run)

    def test_uses_lsof_when_available(self):
        with self.run_cmd(lsof="18703\n"):
            self.assertEqual(self.dev._listening_pids(8016), [18703])

    def test_falls_back_to_ss_when_lsof_missing(self):
        with self.run_cmd(ss=SS_OUTPUT):
            self.assertEqual(self.dev._listening_pids(8016), [18703])

    def test_ss_fallback_matches_every_socket_for_the_port(self):
        with self.run_cmd(ss=SS_OUTPUT):
            self.assertEqual(self.dev._listening_pids(8040), [30720, 30720])

    def test_ss_fallback_ignores_other_ports(self):
        with self.run_cmd(ss=SS_OUTPUT):
            self.assertEqual(self.dev._listening_pids(9999), [])

    def test_ss_fallback_does_not_match_on_address_substring(self):
        """127.0.0.54:53 must not satisfy a query for port 54 or 127."""
        with self.run_cmd(ss=SS_OUTPUT):
            self.assertEqual(self.dev._listening_pids(54), [])
            self.assertEqual(self.dev._listening_pids(127), [])

    def test_empty_lsof_result_still_consults_ss(self):
        """An installed lsof that returns nothing is indistinguishable from a
        missing one, so the fallback must still run."""
        with self.run_cmd(lsof="", ss=SS_OUTPUT):
            self.assertEqual(self.dev._listening_pids(8016), [18703])

    def test_returns_empty_when_no_tool_is_available(self):
        with self.run_cmd():
            self.assertEqual(self.dev._listening_pids(8016), [])


if __name__ == "__main__":
    unittest.main()
