"""Filesystem installation and independent ZIP validation; no client or provider calls."""

import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("install_scout_skill", ROOT / "scripts/install-scout-skill.py")
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)
PACKAGE = ROOT / "apps/docs/skills"


class ScoutSkillTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="scout-skill-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.manifest, self.files = installer.package_files(PACKAGE)

    def test_project_installs_for_both_clients_and_copies_only_instruction_files(self):
        for client, folder in [("codex", ".agents"), ("claude", ".claude")]:
            project = self.root / ("project with spaces " + client)
            project.mkdir()
            target = installer.destination(client, project=project)
            self.assertEqual(target, project / folder / "skills/scout-qa")
            installer.install(PACKAGE, target)
            installed = {p.relative_to(target).as_posix(): p.read_bytes() for p in target.rglob("*") if p.is_file()}
            self.assertEqual(installed, self.files)
            self.assertEqual(len(installed), 3)
            self.assertFalse(any(p.suffix in [".py", ".js", ".mjs", ".sh"] for p in target.rglob("*")))

    def test_dry_run_creates_nothing(self):
        target = installer.destination("codex", skills_dir=self.root / "new parent")
        result = installer.install(PACKAGE, target, dry_run=True)
        self.assertIn("Would install", result)
        self.assertFalse(target.parent.exists())

    def test_identical_reinstall_is_a_noop_and_different_files_are_preserved(self):
        target = self.root / "skills/scout-qa"
        installer.install(PACKAGE, target)
        before = {p: p.stat().st_mtime_ns for p in target.rglob("*") if p.is_file()}
        self.assertIn("Already installed", installer.install(PACKAGE, target))
        self.assertEqual(before, {p: p.stat().st_mtime_ns for p in before})
        (target / "SKILL.md").write_text("Existing user customization", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "different skill already exists"):
            installer.install(PACKAGE, target)
        self.assertEqual((target / "SKILL.md").read_text(), "Existing user customization")

    def test_existing_and_broken_destination_symlinks_are_rejected(self):
        other = self.root / "other"
        other.mkdir()
        for name, actual in [("valid", other), ("broken", self.root / "missing")]:
            target = self.root / name
            target.symlink_to(actual, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "Destination exists"):
                installer.install(PACKAGE, target)
            self.assertTrue(target.is_symlink())
        self.assertEqual(list(other.iterdir()), [])

    def test_source_path_escape_and_symlinks_are_rejected(self):
        package = self.root / "source"
        (package / "scout-qa").mkdir(parents=True)
        outside = self.root / "private"
        outside.write_text("must not be packaged", encoding="utf-8")
        manifest = {"name": "scout-qa", "files": ["../private"]}
        (package / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Unsafe skill file path"):
            installer.package_files(package)
        manifest["files"] = ["SKILL.md"]
        (package / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        (package / "scout-qa/SKILL.md").symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "stay inside"):
            installer.package_files(package)

    def test_cli_dry_run_and_custom_install_without_optional_python_packages(self):
        target_parent = self.root / "custom skills"
        command = ["python3", "-S", str(ROOT / "scripts/install-scout-skill.py"), "--skills-dir", str(target_parent)]
        dry = subprocess.run(command + ["--dry-run"], capture_output=True, text=True)
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertFalse(target_parent.exists())
        actual = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(actual.returncode, 0, actual.stderr)
        self.assertEqual((target_parent / "scout-qa/SKILL.md").read_bytes(), self.files["SKILL.md"])

    def test_zip_from_native_node_writer_is_readable_by_independent_python_reader(self):
        module = (ROOT / "apps/docs/scripts/skill-package.mjs").as_uri()
        program = """
const {skillFiles, skillZip} = await import(process.argv[1]);
const {manifest, files} = await skillFiles();
const first = skillZip(manifest.name, files);
const second = skillZip(manifest.name, files);
if (!first.equals(second)) throw new Error('Non-deterministic archive');
process.stdout.write(first);
"""
        result = subprocess.run(["node", "--input-type=module", "--eval", program, module], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertLess(len(result.stdout), 8192)
        with zipfile.ZipFile(io.BytesIO(result.stdout)) as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual(set(archive.namelist()), {"scout-qa/" + filename for filename in self.files})
            for filename, content in self.files.items():
                self.assertEqual(archive.read("scout-qa/" + filename), content)


if __name__ == "__main__":
    unittest.main()
