import runpy
import unittest
from pathlib import Path

check = runpy.run_path(str(Path(__file__).with_name("check-nuget-audit.py")))["check"]


class AuditGateTests(unittest.TestCase):
    def report(self, group="topLevelPackages", severity="High"):
        return {"version": 1, "projects": [{"path": "Api.csproj", "frameworks": [{group: [
            {"id": "Example", "resolvedVersion": "1.0.0", "vulnerabilities": [
                {"severity": severity, "advisoryurl": "https://example.test/advisory"}]}]}]}]}

    def test_high_and_critical_including_transitive_dependencies_fail(self):
        for group in ("topLevelPackages", "transitivePackages"):
            for severity in ("High", "Critical"):
                with self.subTest(group=group, severity=severity):
                    self.assertEqual(1, len(check(self.report(group, severity))))

    def test_low_moderate_and_clean_reports_pass(self):
        for severity in ("Low", "Moderate"):
            self.assertEqual([], check(self.report(severity=severity)))
        self.assertEqual([], check({"version": 1, "projects": []}))

    def test_failed_or_incomplete_audits_fail_closed(self):
        for report in ({}, {"version": 2, "projects": []},
                       {"version": 1, "projects": [], "problems": [{"level": "warning", "text": "Feed unavailable"}]}):
            with self.subTest(report=report), self.assertRaises(ValueError):
                check(report)


if __name__ == "__main__":
    unittest.main()
