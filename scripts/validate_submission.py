#!/usr/bin/env python3
"""Validate Tama Builder against public skills-only submission constraints."""

from __future__ import annotations

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse


CATEGORIES = {
    "Productivity",
    "Creativity",
    "Developer Tools",
    "Business & Operations",
    "Data & Analytics",
    "Communication",
    "Education & Research",
    "Security",
    "Finance",
    "Healthcare",
    "Travel",
    "Entertainment",
    "Other",
}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".svg"}
SEMVER = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)


class SubmissionError(ValueError):
    """Raised when the package is not ready for directory submission."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SubmissionError(message)


def read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SubmissionError(f"Cannot read valid JSON from {path}: {error}") from error


def require_text(value: object, field: str, maximum: int, *, one_line: bool = True) -> str:
    require(
        isinstance(value, str) and value.strip() == value and bool(value),
        f"{field} must be non-empty text",
    )
    require(
        len(value) <= maximum,
        f"{field} must be {maximum} characters or fewer (found {len(value)})",
    )
    if one_line:
        require("\n" not in value and "\r" not in value, f"{field} must fit on one line")
    return value


def require_https_url(value: object, field: str) -> None:
    text = require_text(value, field, 1024)
    parsed = urlparse(text)
    require(
        parsed.scheme == "https" and bool(parsed.netloc),
        f"{field} must be a public HTTPS URL",
    )
    require(
        parsed.username is None and parsed.password is None,
        f"{field} must not embed credentials",
    )


def parse_svg_dimensions(path: Path) -> tuple[float, float]:
    try:
        root = ET.parse(path).getroot()
    except (OSError, ET.ParseError) as error:
        raise SubmissionError(f"Cannot parse SVG {path}: {error}") from error

    require(root.tag.rsplit("}", 1)[-1] == "svg", f"{path} must have an <svg> root")

    view_box = root.get("viewBox")
    if view_box:
        try:
            values = [float(value) for value in re.split(r"[\s,]+", view_box.strip())]
        except ValueError as error:
            raise SubmissionError(f"{path} has a non-numeric viewBox") from error
        require(len(values) == 4, f"{path} viewBox must contain four numbers")
        width, height = values[2], values[3]
    else:
        width_text = root.get("width", "")
        height_text = root.get("height", "")
        numeric = re.compile(r"^(?:\d+(?:\.\d*)?|\.\d+)$")
        require(
            bool(numeric.fullmatch(width_text)),
            f"{path} width must be numeric and unitless",
        )
        require(
            bool(numeric.fullmatch(height_text)),
            f"{path} height must be numeric and unitless",
        )
        width, height = float(width_text), float(height_text)

    require(width >= 48 and height >= 48, f"{path} must be at least 48x48")
    require(width == height, f"{path} must be square (found {width}x{height})")
    return width, height


def validate_asset(root: Path, value: object, field: str) -> None:
    text = require_text(value, field, 2048)
    require(text.startswith("./"), f"{field} must start with ./")
    relative = PurePosixPath(text[2:])
    require(
        not relative.is_absolute() and ".." not in relative.parts,
        f"{field} must stay inside the plugin",
    )
    path = root.joinpath(*relative.parts)
    require(
        path.is_file() and not path.is_symlink(),
        f"{field} must reference a regular packaged file",
    )
    require(
        path.suffix.lower() in IMAGE_SUFFIXES,
        f"{field} uses an unsupported image type",
    )
    require(
        path.stat().st_size <= 5 * 1024 * 1024,
        f"{field} must not exceed 5 MiB",
    )
    if path.suffix.lower() == ".svg":
        parse_svg_dimensions(path)


def validate_manifest(root: Path) -> tuple[dict[str, object], dict[str, object]]:
    manifest = read_json(root / ".codex-plugin" / "plugin.json")
    package = read_json(root / "package.json")
    require(isinstance(manifest, dict), "Plugin manifest must contain a JSON object")
    require(isinstance(package, dict), "package.json must contain a JSON object")

    name = require_text(manifest.get("name"), "name", 64)
    require(
        bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", name)),
        "name has unsupported characters",
    )
    version = require_text(manifest.get("version"), "version", 64)
    require(bool(SEMVER.fullmatch(version)), "version must use semantic versioning")
    require(
        package.get("version") == version,
        "package.json and plugin manifest versions must match",
    )
    require(
        package.get("license") == "Apache-2.0",
        "package.json license must be Apache-2.0",
    )

    require(
        "mcpServers" not in manifest and not (root / ".mcp.json").exists(),
        "Skills-only ZIP must not include MCP configuration",
    )
    require(
        "apps" not in manifest and not (root / ".app.json").exists(),
        "Skills-only ZIP must not include app configuration",
    )

    interface = manifest.get("interface")
    require(isinstance(interface, dict), "interface must contain a JSON object")
    require_text(interface.get("displayName"), "interface.displayName", 30)
    require_text(interface.get("shortDescription"), "interface.shortDescription", 30)
    require_text(
        interface.get("longDescription"),
        "interface.longDescription",
        4000,
        one_line=False,
    )
    require_text(interface.get("developerName"), "interface.developerName", 80)
    require(interface.get("category") in CATEGORIES, "interface.category is unsupported")

    capabilities = interface.get("capabilities", [])
    require(
        isinstance(capabilities, list) and len(capabilities) <= 20,
        "interface.capabilities must contain at most 20 entries",
    )
    for index, capability in enumerate(capabilities):
        require_text(capability, f"interface.capabilities[{index}]", 120)

    prompts = interface.get("defaultPrompt", [])
    require(
        isinstance(prompts, list) and len(prompts) <= 3,
        "interface.defaultPrompt must contain at most three entries",
    )
    normalized_prompts: set[str] = set()
    for index, prompt in enumerate(prompts):
        prompt_text = require_text(prompt, f"interface.defaultPrompt[{index}]", 128)
        require(
            "@" not in prompt_text,
            f"interface.defaultPrompt[{index}] must not contain an app @mention",
        )
        normalized = " ".join(prompt_text.split()).casefold()
        require(
            normalized not in normalized_prompts,
            "interface.defaultPrompt entries must be unique",
        )
        normalized_prompts.add(normalized)

    for field in (
        "websiteURL",
        "privacyPolicyURL",
        "termsOfServiceURL",
        "supportURL",
    ):
        if field in interface:
            require_https_url(interface[field], f"interface.{field}")

    validate_asset(root, interface.get("logo"), "interface.logo")
    validate_asset(root, interface.get("composerIcon"), "interface.composerIcon")
    return manifest, package


def validate_case_text(case: dict[str, object], field: str, case_id: str) -> None:
    require_text(case.get(field), f"{case_id}.{field}", 4000, one_line=False)


def validate_evals(root: Path) -> tuple[int, int]:
    data = read_json(root / "evals" / "cases.json")
    require(isinstance(data, dict), "evals/cases.json must contain a JSON object")
    positive = data.get("positive_cases")
    negative = data.get("negative_cases")
    require(
        isinstance(positive, list) and len(positive) >= 5,
        "At least five positive test cases are required",
    )
    require(
        isinstance(negative, list) and len(negative) >= 3,
        "At least three negative test cases are required",
    )

    seen_ids: set[str] = set()
    for case in positive:
        require(isinstance(case, dict), "Each positive test case must be an object")
        case_id = require_text(case.get("id"), "positive case id", 120)
        require(case_id not in seen_ids, f"Duplicate test case id: {case_id}")
        seen_ids.add(case_id)
        validate_case_text(case, "prompt", case_id)
        require_text(case.get("skill"), f"{case_id}.skill", 120)
        behavior = case.get("expected_behavior")
        require(
            isinstance(behavior, list) and bool(behavior),
            f"{case_id}.expected_behavior must be a non-empty list",
        )
        for index, item in enumerate(behavior):
            require_text(
                item,
                f"{case_id}.expected_behavior[{index}]",
                1000,
                one_line=False,
            )
        validate_case_text(case, "expected_result_shape", case_id)
        validate_case_text(case, "fixture_data", case_id)

    for case in negative:
        require(isinstance(case, dict), "Each negative test case must be an object")
        case_id = require_text(case.get("id"), "negative case id", 120)
        require(case_id not in seen_ids, f"Duplicate test case id: {case_id}")
        seen_ids.add(case_id)
        validate_case_text(case, "prompt", case_id)
        validate_case_text(case, "expected_behavior", case_id)
        validate_case_text(case, "reason", case_id)

    portal = read_json(root / "submission" / "portal.json")
    require(isinstance(portal, dict), "submission/portal.json must contain a JSON object")
    require(portal.get("submissionType") == "Skills only", "submissionType must be Skills only")
    listing = portal.get("listing")
    require(isinstance(listing, dict), "submission listing must be an object")
    for field in (
        "websiteURL",
        "privacyPolicyURL",
        "termsOfServiceURL",
        "supportURL",
    ):
        require_https_url(listing.get(field), f"submission.listing.{field}")
    validate_case_text(portal, "releaseNotes", "submission")

    positive_ids = {case["id"] for case in positive}
    negative_ids = {case["id"] for case in negative}
    selected_positive = portal.get("positiveCaseIds")
    selected_negative = portal.get("negativeCaseIds")
    require(
        isinstance(selected_positive, list) and len(selected_positive) >= 5,
        "submission.positiveCaseIds must select at least five positive cases",
    )
    require(
        isinstance(selected_negative, list) and len(selected_negative) >= 3,
        "submission.negativeCaseIds must select at least three negative cases",
    )
    for index, case_id in enumerate(selected_positive):
        require_text(case_id, f"submission.positiveCaseIds[{index}]", 120)
    for index, case_id in enumerate(selected_negative):
        require_text(case_id, f"submission.negativeCaseIds[{index}]", 120)
    require(
        len(selected_positive) == len(set(selected_positive)),
        "submission.positiveCaseIds must be unique",
    )
    require(
        len(selected_negative) == len(set(selected_negative)),
        "submission.negativeCaseIds must be unique",
    )
    require(
        set(selected_positive).issubset(positive_ids),
        "submission.positiveCaseIds contains an unknown case",
    )
    require(
        set(selected_negative).issubset(negative_ids),
        "submission.negativeCaseIds contains an unknown case",
    )

    return len(positive), len(negative)


def validate_repository(root: Path) -> tuple[dict[str, object], dict[str, object]]:
    root = root.resolve()
    manifest, package = validate_manifest(root)
    positive_count, negative_count = validate_evals(root)
    print(
        f"Submission validation passed: {manifest['name']} {manifest['version']} "
        f"({positive_count} positive, {negative_count} negative cases)"
    )
    return manifest, package


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "root",
        nargs="?",
        type=Path,
        default=Path(__file__).resolve().parents[1],
    )
    args = parser.parse_args()
    try:
        validate_repository(args.root)
    except SubmissionError as error:
        print(f"Submission validation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
