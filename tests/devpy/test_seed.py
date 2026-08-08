import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]


def load_devpy():
    spec = importlib.util.spec_from_file_location("devpy_seed_under_test", ROOT / "dev.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ModernSeedTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dev = load_devpy()
        # Debug, not release. This binary is only ever invoked as
        # `--migrate-only`, which exits as soon as the migration chain is
        # applied, so the profile cannot affect what this suite asserts. It
        # does affect the check pipeline enormously: a release build here
        # holds the shared workspace target lock against the concurrent
        # debug builds in the rust and e2e lanes, which starved the rust
        # lane's test compile into its timeout. Debug also reuses the binary
        # the e2e lane already builds.
        binary = ROOT / "target" / "debug" / "phoenix_ide"
        cls.dev.build_rust(release=False)
        if not binary.exists():
            raise AssertionError(f"debug phoenix_ide binary was not built: {binary}")

    def test_fresh_seed_and_fixture_repair_use_migrated_schema(self):
        with tempfile.TemporaryDirectory(prefix="phoenix-modern-seed-") as directory:
            db_path = Path(directory) / "seed.db"
            seed_worktree_root = Path(directory) / "seed-worktrees"
            with (
                mock.patch.object(self.dev, "get_db_path", return_value=db_path),
                mock.patch.object(self.dev, "get_pid", return_value=None),
                mock.patch.object(
                    self.dev,
                    "SEED_WORKTREE_ROOT",
                    seed_worktree_root,
                ),
            ):
                self.dev.cmd_seed(build=False, release=False)
                with sqlite3.connect(db_path) as conn:
                    columns = {
                        row[1] for row in conn.execute("PRAGMA table_info(conversations)")
                    }
                    self.assertNotIn("cwd", columns)
                    self.assertNotIn("conv_mode", columns)
                    self.assertEqual(
                        conn.execute(
                            "SELECT COUNT(*) FROM conversations WHERE work_scope_id IS NULL"
                        ).fetchone()[0],
                        0,
                    )
                    direct_scope_groups = conn.execute(
                        "SELECT COUNT(*), COUNT(DISTINCT work_scope_id)"
                        " FROM conversations"
                        " WHERE slug GLOB 'refactor-the-database-connection-pool-current*'"
                    ).fetchone()
                    self.assertEqual(direct_scope_groups[0], direct_scope_groups[1])
                    fixture = conn.execute(
                        "SELECT id FROM conversations WHERE slug = 'fixture-diff-review'"
                    ).fetchone()
                    self.assertIsNotNone(fixture)
                    fixture_id = fixture[0]
                    fixture_scope = conn.execute(
                        "SELECT work_scope_id FROM conversations WHERE id = ?",
                        (fixture_id,),
                    ).fetchone()[0]
                    user_content = conn.execute(
                        "SELECT content FROM messages"
                        " WHERE conversation_id = ? AND message_type = 'user'",
                        (fixture_id,),
                    ).fetchone()[0]
                    self.assertNotIn('"images"', user_content)

                    columns = [
                        row[1] for row in conn.execute("PRAGMA table_info(conversations)")
                    ]
                    source = conn.execute(
                        f"SELECT {', '.join(columns)} FROM conversations WHERE id = ?",
                        (fixture_id,),
                    ).fetchone()
                    successor = dict(zip(columns, source, strict=True))
                    successor.update({
                        "id": "seed-repair-successor",
                        "slug": "seed-repair-successor",
                        "title": "Seed Repair Successor",
                        "parent_conversation_id": None,
                        "seed_label": None,
                        "continued_in_conv_id": None,
                    })
                    conn.execute(
                        f"INSERT INTO conversations ({', '.join(columns)})"
                        f" VALUES ({', '.join('?' for _ in columns)})",
                        tuple(successor[column] for column in columns),
                    )
                    conn.execute(
                        "DELETE FROM messages WHERE conversation_id = ?", fixture
                    )
                    conn.execute(
                        "UPDATE work_scopes SET worktree_path = ? WHERE id = ?",
                        ("/tmp/stale-seed-worktree", fixture_scope),
                    )
                    conn.commit()

                self.dev.cmd_seed(build=False, release=False, repair_fixtures=True)

                with sqlite3.connect(db_path) as conn:
                    self.assertEqual(
                        conn.execute(
                            "SELECT COUNT(*) FROM messages m"
                            " JOIN conversations c ON c.id = m.conversation_id"
                            " WHERE c.slug = 'fixture-diff-review'"
                        ).fetchone()[0],
                        1,
                    )
                    self.assertEqual(
                        conn.execute(
                            "SELECT work_scope_id FROM conversations WHERE id = ?",
                            ("seed-repair-successor",),
                        ).fetchone()[0],
                        fixture_scope,
                    )
                    self.assertEqual(
                        conn.execute(
                            "SELECT COUNT(*) FROM work_scopes WHERE id = ?",
                            (fixture_scope,),
                        ).fetchone()[0],
                        1,
                    )
                    repaired_scope = conn.execute(
                        "SELECT work_scope_id FROM conversations"
                        " WHERE slug = 'fixture-diff-review'"
                    ).fetchone()[0]
                    self.assertNotEqual(repaired_scope, fixture_scope)
                    self.assertEqual(
                        conn.execute(
                            "SELECT worktree_path FROM work_scope_environments"
                            " WHERE work_scope_id = ?",
                            (repaired_scope,),
                        ).fetchone()[0],
                        str(seed_worktree_root / "diff-review-fixture"),
                    )
                    self.assertEqual(
                        conn.execute(
                            "SELECT COUNT(*) FROM messages"
                            " WHERE message_type = 'user'"
                            " AND json_type(content, '$.images') IS NOT NULL"
                        ).fetchone()[0],
                        0,
                    )
                    self.assertEqual(
                        conn.execute(
                            "SELECT s.environment_kind FROM conversations c"
                            " JOIN work_scopes s ON s.id = c.work_scope_id"
                            " WHERE c.slug = 'fixture-diff-review'"
                        ).fetchone()[0],
                        "allocated_worktree",
                    )


    def test_populated_db_left_alone_unless_repair_requested(self):
        with tempfile.TemporaryDirectory(prefix="phoenix-seed-repair-") as directory:
            db_path = Path(directory) / "seed.db"
            seed_worktree_root = Path(directory) / "seed-worktrees"
            with (
                mock.patch.object(self.dev, "get_db_path", return_value=db_path),
                mock.patch.object(self.dev, "get_pid", return_value=None),
                mock.patch.object(self.dev, "SEED_WORKTREE_ROOT", seed_worktree_root),
            ):
                self.dev.cmd_seed(build=False, release=False)

                with sqlite3.connect(db_path) as conn:
                    conn.execute(
                        "DELETE FROM messages WHERE conversation_id IN"
                        " (SELECT id FROM conversations WHERE slug = 'fixture-turn-one')"
                    )
                    conn.commit()

                # Default: a populated DB is not touched, so the gutted fixture stays gutted.
                self.dev.cmd_seed(build=False, release=False)
                with sqlite3.connect(db_path) as conn:
                    self.assertEqual(self._fixture_message_count(conn, "fixture-turn-one"), 0)

                self.dev.cmd_seed(build=False, release=False, repair_fixtures=True)
                with sqlite3.connect(db_path) as conn:
                    self.assertEqual(self._fixture_message_count(conn, "fixture-turn-one"), 47)

    def test_archived_fixture_is_never_resurrected(self):
        with tempfile.TemporaryDirectory(prefix="phoenix-seed-archived-") as directory:
            db_path = Path(directory) / "seed.db"
            seed_worktree_root = Path(directory) / "seed-worktrees"
            archivable = [
                "fixture-turn-one",
                "fixture-heavy-prod-shape",
                "fixture-diff-review",
                "fixture-grounding-panel-qa",
            ]
            with (
                mock.patch.object(self.dev, "get_db_path", return_value=db_path),
                mock.patch.object(self.dev, "get_pid", return_value=None),
                mock.patch.object(self.dev, "SEED_WORKTREE_ROOT", seed_worktree_root),
            ):
                self.dev.cmd_seed(build=False, release=False)

                with sqlite3.connect(db_path) as conn:
                    for slug in archivable:
                        self.assertIsNotNone(
                            conn.execute(
                                "SELECT id FROM conversations WHERE slug = ?", (slug,)
                            ).fetchone(),
                            f"{slug} was not seeded",
                        )
                    conn.execute(
                        "UPDATE conversations SET archived = 1 WHERE slug IN"
                        f" ({', '.join('?' for _ in archivable)})",
                        tuple(archivable),
                    )
                    conn.commit()

                # Even an explicit repair leaves an archived fixture archived: archiving
                # is a developer decision, not fixture drift.
                self.dev.cmd_seed(build=False, release=False, repair_fixtures=True)

                with sqlite3.connect(db_path) as conn:
                    for slug in archivable:
                        rows = conn.execute(
                            "SELECT archived FROM conversations WHERE slug = ?", (slug,)
                        ).fetchall()
                        self.assertEqual(rows, [(1,)], f"{slug} was resurrected")

    @staticmethod
    def _fixture_message_count(conn: sqlite3.Connection, slug: str) -> int:
        return conn.execute(
            "SELECT COUNT(*) FROM messages m"
            " JOIN conversations c ON c.id = m.conversation_id"
            " WHERE c.slug = ?",
            (slug,),
        ).fetchone()[0]


if __name__ == "__main__":
    unittest.main()
