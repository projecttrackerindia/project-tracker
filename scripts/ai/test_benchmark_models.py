"""Harness-only tests. These use no model or mocked delivery and do not establish model quality."""
import importlib.util, json, unittest
from pathlib import Path
path=Path(__file__).with_name('benchmark-models.py')
spec=importlib.util.spec_from_file_location('benchmark',path)
benchmark=importlib.util.module_from_spec(spec); spec.loader.exec_module(benchmark)
class HarnessTests(unittest.TestCase):
    def test_p95_uses_nearest_rank(self): self.assertEqual(19,benchmark.percentile(list(range(1,21)),.95))
    def test_empty_metrics_remain_unavailable(self): self.assertIsNone(benchmark.percentile([],.95))
    def test_resources_are_not_invented(self): self.assertEqual((0,0),benchmark.resources(None))
    def test_versioned_dataset_has_unique_synthetic_cases(self):
        data=json.loads((path.parents[2]/'evaluation/ai/requests.v1.json').read_text())
        self.assertEqual('1',data['version']); self.assertEqual(18,len(data['cases']))
        self.assertEqual(len(data['cases']),len({c['id'] for c in data['cases']}))
        self.assertTrue(all('intent' in c['expected'] for c in data['cases']))
if __name__=='__main__': unittest.main()
