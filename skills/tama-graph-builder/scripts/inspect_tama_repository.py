#!/usr/bin/env python3
"""Inventory Tama Terraform versions, installed modules, and declared blocks."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any


SKIP_PARTS = {".git", ".terraform", ".terragrunt-cache", "node_modules", "vendor"}
BLOCK_RE = re.compile(
    r'^\s*(resource|data)\s+"([^"]+)"\s+"([^"]+)"\s*\{'
)
MODULE_RE = re.compile(r'^\s*module\s+"([^"]+)"\s*\{')
ASSIGNMENT_RE = re.compile(r'^\s*(source|version)\s*=\s*"([^"]+)"')
PROVIDER_RE = re.compile(r'provider\s+"([^"]+)"\s*\{(.*?)\n\}', re.DOTALL)
LOCK_VALUE_RE = re.compile(r'^\s*(version|constraints)\s*=\s*"([^"]+)"', re.MULTILINE)


def terraform_files(root: Path) -> list[Path]:
    files = []
    for path in root.rglob("*.tf"):
        if not any(part in SKIP_PARTS for part in path.parts):
            files.append(path)
    return sorted(files)


def parse_declared_blocks(root: Path, files: list[Path]) -> dict[str, Any]:
    counts: Counter[str] = Counter()
    module_calls: list[dict[str, Any]] = []

    for path in files:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        index = 0
        while index < len(lines):
            line = lines[index]
            block_match = BLOCK_RE.match(line)
            if block_match:
                kind, block_type, _ = block_match.groups()
                counts[f"{kind}.{block_type}"] += 1

            module_match = MODULE_RE.match(line)
            if not module_match:
                index += 1
                continue

            counts["module"] += 1
            name = module_match.group(1)
            start_line = index + 1
            depth = line.count("{") - line.count("}")
            values: dict[str, str] = {}
            index += 1

            while index < len(lines) and depth > 0:
                current = lines[index]
                assignment = ASSIGNMENT_RE.match(current)
                if assignment and assignment.group(1) not in values:
                    values[assignment.group(1)] = assignment.group(2)
                depth += current.count("{") - current.count("}")
                index += 1

            module_calls.append(
                {
                    "name": name,
                    "source": values.get("source"),
                    "declared_version": values.get("version"),
                    "file": str(path.relative_to(root)),
                    "line": start_line,
                }
            )

    return {
        "block_counts": dict(sorted(counts.items())),
        "module_calls": module_calls,
    }


def parse_provider_locks(root: Path) -> list[dict[str, str | None]]:
    lock_path = root / ".terraform.lock.hcl"
    if not lock_path.exists():
        return []

    text = lock_path.read_text(encoding="utf-8", errors="replace")
    providers = []
    for source, body in PROVIDER_RE.findall(text):
        values = dict(LOCK_VALUE_RE.findall(body))
        providers.append(
            {
                "source": source,
                "version": values.get("version"),
                "constraints": values.get("constraints"),
            }
        )
    return providers


def parse_installed_modules(root: Path) -> list[dict[str, Any]]:
    modules_path = root / ".terraform" / "modules" / "modules.json"
    if not modules_path.exists():
        return []

    try:
        payload = json.loads(modules_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"cannot read {modules_path}: {error}") from error

    installed = []
    for item in payload.get("Modules", []):
        directory = item.get("Dir")
        resolved = root / directory if directory else root
        installed.append(
            {
                "key": item.get("Key", ""),
                "source": item.get("Source", ""),
                "version": item.get("Version"),
                "directory": directory,
                "directory_exists": resolved.exists(),
            }
        )
    return installed


def build_inventory(root: Path) -> dict[str, Any]:
    files = terraform_files(root)
    declared = parse_declared_blocks(root, files)
    installed = parse_installed_modules(root)
    installed_by_key = {item["key"]: item for item in installed if item["key"]}

    for call in declared["module_calls"]:
        match = installed_by_key.get(call["name"])
        call["installed_version"] = match.get("version") if match else None
        call["installed_directory"] = match.get("directory") if match else None

    warnings = []
    if not (root / ".terraform.lock.hcl").exists():
        warnings.append("No .terraform.lock.hcl was found.")
    if not installed:
        warnings.append("No .terraform/modules/modules.json was found; modules may be uninitialized.")

    return {
        "repository": str(root),
        "terraform_file_count": len(files),
        "provider_locks": parse_provider_locks(root),
        "declared": declared,
        "installed_module_count": len(installed),
        "installed_modules": installed,
        "warnings": warnings,
    }


def print_text(inventory: dict[str, Any], show_all_modules: bool) -> None:
    print(f"Repository: {inventory['repository']}")
    print(f"Terraform files: {inventory['terraform_file_count']}")

    print("\nProvider locks:")
    providers = inventory["provider_locks"]
    if not providers:
        print("  none")
    for provider in providers:
        details = f"version={provider['version'] or 'unknown'}"
        if provider["constraints"]:
            details += f" constraints={provider['constraints']}"
        print(f"  {provider['source']}: {details}")

    print("\nDeclared Tama blocks:")
    counts = inventory["declared"]["block_counts"]
    tama_counts = {key: value for key, value in counts.items() if "tama_" in key or key == "module"}
    if not tama_counts:
        print("  none")
    for key, value in sorted(tama_counts.items()):
        print(f"  {key}: {value}")

    print("\nDeclared module calls:")
    calls = inventory["declared"]["module_calls"]
    if not calls:
        print("  none")
    for call in calls:
        source = call["source"] or "dynamic-or-unknown"
        declared = call["declared_version"] or "local-or-unpinned"
        installed = call["installed_version"] or "not-matched"
        print(
            f"  {call['file']}:{call['line']} module.{call['name']} "
            f"source={source} declared={declared} installed={installed}"
        )

    print(f"\nInstalled modules: {inventory['installed_module_count']}")
    if show_all_modules:
        for module in inventory["installed_modules"]:
            if not module["key"]:
                continue
            version = module["version"] or "local"
            exists = "yes" if module["directory_exists"] else "no"
            print(
                f"  {module['key']}: source={module['source']} version={version} "
                f"dir={module['directory']} exists={exists}"
            )

    for warning in inventory["warnings"]:
        print(f"\nWarning: {warning}", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repository", nargs="?", default=".", help="Terraform repository to inspect")
    parser.add_argument("--json", action="store_true", dest="as_json", help="Emit the complete inventory as JSON")
    parser.add_argument("--all-modules", action="store_true", help="List every installed module in text output")
    args = parser.parse_args()

    root = Path(args.repository).expanduser().resolve()
    if not root.is_dir():
        parser.error(f"repository is not a directory: {root}")

    try:
        inventory = build_inventory(root)
    except RuntimeError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    if args.as_json:
        print(json.dumps(inventory, indent=2, sort_keys=True))
    else:
        print_text(inventory, args.all_modules)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
