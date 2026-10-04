"""seen_jobs.fingerprint() against the fixtures shared with the TypeScript port."""

import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from seen_jobs import fingerprint  # noqa: E402

with open(os.path.join(ROOT, "tests", "fixtures", "fingerprints.json"), encoding="utf-8") as fh:
    CASES = json.load(fh)


class Fingerprint(unittest.TestCase):
    def test_shared_fixtures(self):
        for case in CASES:
            with self.subTest(case["name"]):
                self.assertEqual(fingerprint(case["job"]), case["fingerprint"])


if __name__ == "__main__":
    unittest.main()
