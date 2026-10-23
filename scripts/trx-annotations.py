"""Turns failed tests in .trx reports into GitHub annotations, so failures are readable from the PR's checks page and the API
(without opening the raw log). GitHub keeps at most 10 error annotations per step, so failures are grouped into at most 10."""
import glob
import sys
import xml.etree.ElementTree as ET

NS = {"t": "http://microsoft.com/schemas/VisualStudio/TeamTest/2010"}


def failures(folder):
    for path in glob.glob(f"{folder}/**/*.trx", recursive=True):
        root = ET.parse(path).getroot()
        for r in root.iterfind(".//t:UnitTestResult", NS):
            if r.get("outcome") != "Failed":
                continue
            msg = r.findtext(".//t:ErrorInfo/t:Message", default="", namespaces=NS).strip()
            stack = r.findtext(".//t:ErrorInfo/t:StackTrace", default="", namespaces=NS).strip()
            where = next((line.strip() for line in stack.splitlines() if " in " in line and ".cs:line" in line), "")
            yield r.get("testName", "?"), msg, where


def escape(s):
    return s.replace("%", "%25").replace("\r", "").replace("\n", "%0A")


def main():
    items = list(failures(sys.argv[1] if len(sys.argv) > 1 else "TestResults"))
    if not items:
        print("No failed tests found in the reports.")
        return
    print(f"{len(items)} failed test(s).")
    groups = [items[i::10] for i in range(min(10, len(items)))]
    for n, group in enumerate(groups, 1):
        body = "\n\n".join(f"{name}\n{msg[:2500]}\n{where}" for name, msg, where in group)
        print(f"::error title=Failed tests ({n}/{len(groups)})::{escape(body[:9000])}")


if __name__ == "__main__":
    main()
