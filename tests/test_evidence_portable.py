"""Portable ledger verification, independent of the app server."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from ghostwheel.engine import World
from ghostwheel.recorder import Recorder

source = Path(__file__).resolve().parents[1] / 'scripts' / 'verify-evidence.py'
spec = importlib.util.spec_from_file_location('verify_ghostwheel_evidence', source)
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)

class PortableEvidenceTests(unittest.TestCase):
    def test_roundtrip_and_tampering(self):
        with tempfile.TemporaryDirectory() as folder:
            recorder = Recorder(Path(folder) / 'evidence.sqlite3')
            world = World('aster', 42)
            recorder.begin(world)
            for _ in range(3):
                world.step()
                recorder.frame(world)
            bundle = recorder.evidence(recorder.run_id)
            self.assertEqual(verifier.validate(bundle)['frames'], 3)
            bundle = json.loads(json.dumps(bundle))
            bundle['events'][-1]['payload']['snapshot']['vehicle']['speed_mps'] = 99
            with self.assertRaises(verifier.InvalidEvidence):
                verifier.validate(bundle)
            recorder.close()

    def test_wrong_external_anchor(self):
        with tempfile.TemporaryDirectory() as folder:
            recorder = Recorder(Path(folder) / 'evidence.sqlite3')
            recorder.begin(World())
            bundle = recorder.evidence(recorder.run_id)
            with self.assertRaises(verifier.InvalidEvidence):
                verifier.validate(bundle, 'f' * 64)
            recorder.close()

if __name__ == '__main__':
    unittest.main()
