"""Fail CI on high/critical advisories or an unsuccessful NuGet audit report."""
import json
import sys
from pathlib import Path


def check(report):
    if report.get("version") != 1 or not isinstance(report.get("projects"), list):
        raise ValueError("Expected a version 1 dotnet package audit report with projects")
    if report.get("problems"):
        raise ValueError("NuGet could not complete the vulnerability audit")
    failures = []
    for project in report["projects"]:
        for framework in project.get("frameworks", []):
            for group in ("topLevelPackages", "transitivePackages"):
                for package in framework.get(group, []):
                    for advisory in package.get("vulnerabilities", []):
                        if advisory["severity"].lower() in ("high", "critical"):
                            failures.append(f'{project["path"]}: {package["id"]} '
                                            f'{package["resolvedVersion"]}: {advisory["severity"]} '
                                            f'{advisory["advisoryurl"]}')
    return failures


if __name__ == "__main__":
    try:
        failures = check(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8-sig")))
    except (OSError, ValueError, KeyError, IndexError, TypeError) as error:
        print(f"NuGet audit failed: {error}", file=sys.stderr)
        sys.exit(1)
    for failure in failures:
        print(f"::error::{failure}")
    sys.exit(1 if failures else 0)
