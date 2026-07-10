import unittest
from unittest.mock import MagicMock, patch
import sys
import os

# Mock dependencies
sys.modules['schedulemaker'] = MagicMock()
sys.modules['utils'] = MagicMock()
sys.modules['smsalert'] = MagicMock()
sys.modules['paho.mqtt.client'] = MagicMock()

# Import ESP32Manager
from ESP32Manager import ESP32Manager

class TestBatching(unittest.TestCase):
    def setUp(self):
        self.slaves = [
            {"id": "ID1", "name": "dev1", "wireless": True},
            {"id": "ID2", "name": "dev2", "wireless": True},
        ]
        self.manager = ESP32Manager(self.slaves, True)
        # Mock _execute_internal to return dummy results
        self.manager._execute_internal = MagicMock()
        
    def test_batching_single_device(self):
        # 6 commands for ID1. Should be split into 2 batches of 3.
        cmds = ";".join([f"ID1 s {i} 0 0" for i in range(6)])
        
        def side_effect(cmd_str, timeout):
            count = len(cmd_str.split(';'))
            return {i: {"status": True} for i in range(count)}
            
        self.manager._execute_internal.side_effect = side_effect
        
        results = self.manager.run_command(cmds)
        
        # Verify _execute_internal was called twice
        self.assertEqual(self.manager._execute_internal.call_count, 2)
        
        # Check call args
        calls = self.manager._execute_internal.call_args_list
        batch1 = calls[0][0][0]
        batch2 = calls[1][0][0]
        
        self.assertEqual(len(batch1.split(';')), 3)
        self.assertEqual(len(batch2.split(';')), 3)
        
        # Verify results are merged correctly (indices 0-5)
        self.assertEqual(len(results), 6)
        self.assertTrue(all(k in results for k in range(6)))

    def test_batching_multiple_devices(self):
        # ID1: 4 commands, ID2: 2 commands
        # Sequence: ID1, ID1, ID1, ID1, ID2, ID2
        # Batch 1: ID1, ID1, ID1. Next ID1 makes count 4 -> Push.
        # Batch 1 contains: ID1, ID1, ID1.
        # New Batch starts with ID1. Then ID2, ID2.
        # Batch 2: ID1, ID2, ID2.
        
        cmds = "ID1 1; ID1 2; ID1 3; ID1 4; ID2 1; ID2 2"
        
        self.manager._execute_internal.side_effect = lambda c, t: {i: {"status": True} for i in range(len(c.split(';')))}
        
        self.manager.run_command(cmds)
        
        self.assertEqual(self.manager._execute_internal.call_count, 2)
        calls = self.manager._execute_internal.call_args_list
        
        # Batch 1 should have 3 commands (ID1, ID1, ID1)
        self.assertEqual(len(calls[0][0][0].split(';')), 3)
        # Batch 2 should have 3 commands (ID1, ID2, ID2)
        self.assertEqual(len(calls[1][0][0].split(';')), 3)

    def test_interleaved_commands(self):
        # ID1, ID2, ID1, ID2, ID1, ID2, ID1, ID2
        # 1. ID1 (1) -> Add
        # 2. ID2 (1) -> Add
        # 3. ID1 (2) -> Add
        # 4. ID2 (2) -> Add
        # 5. ID1 (3) -> Add
        # 6. ID2 (3) -> Add
        # 7. ID1 (4) -> Full! Push batch.
        #    Batch 1: 6 commands.
        #    New Batch: ID1 (1).
        # 8. ID2 (4) -> Full! Push batch.
        #    Batch 2: 1 command (ID1).
        #    New Batch: ID2 (1).
        # Result: 3 batches.
        
        cmds = "ID1 1; ID2 1; ID1 2; ID2 2; ID1 3; ID2 3; ID1 4; ID2 4"
        
        self.manager._execute_internal.side_effect = lambda c, t: {i: {"status": True} for i in range(len(c.split(';')))}
        
        self.manager.run_command(cmds)
        
        self.assertEqual(self.manager._execute_internal.call_count, 3)
        calls = self.manager._execute_internal.call_args_list
        
        self.assertEqual(len(calls[0][0][0].split(';')), 6)
        self.assertEqual(len(calls[1][0][0].split(';')), 1)
        self.assertEqual(len(calls[2][0][0].split(';')), 1)

if __name__ == '__main__':
    unittest.main()
