#!/usr/bin/env python3
"""Install the three-file Spekios skill using only Python's standard library."""

import argparse
import json
import sys
from pathlib import Path


def package_files(package_root):
    manifest = json.loads((package_root / "manifest.json").read_text(encoding="utf-8"))
    if manifest["name"] != "scout-qa":
        raise ValueError("Unexpected skill name.")
    source = package_root / manifest["name"]
    files = {}
    for relative in manifest["files"]:
        parts = Path(relative).parts
        if not parts or Path(relative).is_absolute() or ".." in parts:
            raise ValueError("Unsafe skill file path.")
        filename = source / relative
        if filename.is_symlink() or not filename.resolve().is_relative_to(source.resolve()):
            raise ValueError("Skill files must stay inside their source folder.")
        files[relative] = filename.read_bytes()
    if "SKILL.md" not in files or not files:
        raise ValueError("Missing SKILL.md.")
    return manifest, files


def destination(client, project=None, skills_dir=None):
    if skills_dir is not None:
        parent = Path(skills_dir).expanduser().resolve()
    else:
        root = Path(project).expanduser().resolve() if project is not None else Path.home()
        if project is not None and not root.is_dir():
            raise ValueError("The project directory must already exist.")
        parent = root / (".agents" if client == "codex" else ".claude") / "skills"
    return parent / "scout-qa"


def install(package_root, target, dry_run=False):
    manifest, files = package_files(package_root)
    if target.exists() or target.is_symlink():
        if target.is_symlink() or not target.is_dir():
            raise ValueError("Destination exists; no files were changed: " + str(target))
        existing = {}
        for filename in target.rglob("*"):
            if filename.is_symlink():
                raise ValueError("Destination contains a symlink; no files were changed.")
            if filename.is_file():
                existing[filename.relative_to(target).as_posix()] = filename.read_bytes()
        if existing == files:
            return "Already installed; no files changed: " + str(target)
        raise ValueError("A different skill already exists; review it before replacing it: " + str(target))
    if dry_run:
        return "Would install Spekios " + manifest["version"] + " to " + str(target)

    # Reserve a new directory exclusively. Never merge into or replace a skill.
    target.parent.mkdir(parents=True, exist_ok=True)
    target.mkdir()
    created = []
    try:
        for relative, content in files.items():
            filename = target / relative
            filename.parent.mkdir(parents=True, exist_ok=True)
            with filename.open("xb") as output:
                output.write(content)
            created.append(filename)
    except Exception:
        for filename in reversed(created):
            filename.unlink()
        # Only remove empty directories created by this attempt.
        directories = [p for p in target.rglob("*") if p.is_dir() and not p.is_symlink()]
        for directory in sorted(directories, key=lambda p: len(p.parts), reverse=True):
            try:
                directory.rmdir()
            except OSError:
                pass
        try:
            target.rmdir()
        except OSError:
            pass
        raise
    return "Installed Spekios " + manifest["version"] + " to " + str(target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--client", choices=["codex", "claude"], default="codex")
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument("--project", help="Install for this existing project instead of the user.")
    scope.add_argument("--skills-dir", help="Use an explicit skill parent directory.")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    package_root = Path(__file__).resolve().parents[1] / "apps/docs/skills"
    try:
        result = install(package_root, destination(args.client, args.project, args.skills_dir), args.dry_run)
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, "Spekios skill installation failed: " + str(error) + "\n")
    print(result)
    print("Connect Spekios MCP or configure HTTP separately. No services, permissions or credentials were changed.")


if __name__ == "__main__":
    main()
