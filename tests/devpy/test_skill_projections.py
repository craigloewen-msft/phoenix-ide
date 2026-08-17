import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class SkillProjectionTests(unittest.TestCase):
    def test_phoenix_maintained_skills_have_exact_discovery_projections(self):
        canonical_root = ROOT / "skills"
        projection_root = ROOT / ".agents" / "skills"

        invokable = {
            path.parent.name: path.parent.resolve()
            for path in canonical_root.glob("*/SKILL.md")
        }
        internal = {
            path.name
            for path in canonical_root.iterdir()
            if path.is_dir() and not (path / "SKILL.md").is_file()
        }

        for name, canonical in sorted(invokable.items()):
            with self.subTest(skill=name):
                projection = projection_root / name
                self.assertTrue(projection.is_symlink(), f"missing skill projection: {name}")
                self.assertEqual(projection.resolve(), canonical)

        for name in sorted(internal):
            with self.subTest(internal_resource=name):
                self.assertFalse(
                    (projection_root / name).exists(),
                    f"internal resource directory is projected as an invokable skill: {name}",
                )


if __name__ == "__main__":
    unittest.main()
