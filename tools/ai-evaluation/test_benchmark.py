import unittest
from benchmark import score


class ScoringTests(unittest.TestCase):
    case = {"expectTool": "project_report", "arguments": {"project": "ATLAS"}}
    call = {"function": {"name": "project_report", "arguments": {"project": "ATLAS"}}}

    def test_extra_write_or_duplicate_call_cannot_pass(self):
        self.assertTrue(score(self.case, "", [self.call]))
        self.assertFalse(score(self.case, "", [self.call, self.call]))
        self.assertFalse(score(self.case, "", [self.call, {"function": {"name": "propose_create_project"}}]))

    def test_arguments_and_tool_must_match(self):
        self.assertFalse(score(self.case, "", [{"function": {"name": "project_report", "arguments": "{}"}}]))
        self.assertFalse(score(self.case, "", [{"function": {"name": "project_report", "arguments": {"project": "INVENTED"}}}]))
        self.assertFalse(score(self.case, "Done", []))
        self.assertFalse(score(self.case, "", [None]))
        self.assertFalse(score(self.case, "", [{"function": None}]))

    def test_text_cases_require_an_answer_and_no_tool(self):
        self.assertTrue(score({"expectText": True}, "Hello", []))
        self.assertFalse(score({"expectText": True}, " ", []))
        self.assertFalse(score({"expectText": True}, "Hello", [self.call]))


if __name__ == "__main__":
    unittest.main()
