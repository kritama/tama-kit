#!/usr/bin/env python3
"""Build a deterministic skills-only ZIP for the OpenAI submission portal."""

from __future__ import annotations

import argparse
import hashlib
import json
import stat
import tempfile
import zipfile
from pathlib import Path

from validate_submission import validate_repository


INCLUDED_PATHS = (
    Path(".codex-plugin"),
    Path("assets"),
    Path("skills"),
    Path("LICENSE"),
    Path("README.md"),
    Path("package.json"),
)
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


def collect_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for relative in INCLUDED_PATHS:
        path = root / relative
        if path.is_symlink():
            raise ValueError(f"Submission archives cannot include symlinks: {relative}")
        if path.is_file():
            files.append(path)
            continue
        if not path.is_dir():
            raise ValueError(f"Required submission path is missing: {relative}")
        for candidate in path.rglob("*"):
            candidate_relative = candidate.relative_to(root)
            if "__pycache__" in candidate_relative.parts or candidate.suffix in {
                ".pyc",
                ".pyo",
            }:
                continue
            if candidate.is_symlink():
                raise ValueError(
                    "Submission archives cannot include symlinks: "
                    f"{candidate_relative}"
                )
            if candidate.is_file():
                files.append(candidate)
    return sorted(files, key=lambda path: path.relative_to(root).as_posix())


def build_archive(root: Path, output: Path) -> Path:
    manifest, _package = validate_repository(root)
    files = collect_files(root)
    output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.NamedTemporaryFile(
        dir=output.parent,
        suffix=".zip",
        delete=False,
    ) as handle:
        temporary = Path(handle.name)

    try:
        with zipfile.ZipFile(
            temporary,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
        ) as archive:
            for path in files:
                relative = path.relative_to(root).as_posix()
                mode = stat.S_IMODE(path.stat().st_mode)
                info = zipfile.ZipInfo(relative, ZIP_TIMESTAMP)
                info.create_system = 3
                info.external_attr = mode << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, path.read_bytes(), compresslevel=9)

        if temporary.stat().st_size > 100 * 1024 * 1024:
            raise ValueError("Submission ZIP exceeds the 100 MB compressed limit")
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)

    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    print(
        json.dumps(
            {
                "name": manifest["name"],
                "version": manifest["version"],
                "archive": str(output),
                "files": len(files),
                "bytes": output.stat().st_size,
                "sha256": digest,
            },
            indent=2,
        )
    )
    return output


def main() -> int:
    root_default = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=root_default)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    root = args.root.resolve()
    manifest = json.loads(
        (root / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8")
    )
    output = args.output or root / "dist" / f"{manifest['name']}-{manifest['version']}.zip"
    build_archive(root, output.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
