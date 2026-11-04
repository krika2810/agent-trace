"""Synthetic-log checks for scripts/today_cost.py. Run: python3 -I tests/test_today_cost.py

Every log here is made up in a temporary folder; no real session log is read.
The price table is a small fixture: the real one lives in hooks/pricing.ts and
is checked by the plugin tests.
"""
import contextlib
import datetime
import io
import importlib.util
import json
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location('today_cost', os.path.join(HERE, '..', 'scripts', 'today_cost.py'))
today_cost = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(today_cost)

RATES = {'input': 2, 'write5m': 2.5, 'write1h': 4, 'read': 0.1, 'output': 10}
TABLE = {
    'prices': {
        'sonnet-5-5': {**RATES, 'geo': True},
        'haiku-5-5': {'input': 0.1, 'write5m': 0.125, 'write1h': 0.2, 'read': 0.01, 'output': 0.5,
                      'over': {'tokens': 100000, 'rates': {'input': 0.5, 'write5m': 0.625, 'write1h': 1, 'read': 0.05, 'output': 2.5}}},
        'opus-5-5': {'input': 4, 'write5m': 5, 'write1h': 8, 'read': 0.2, 'output': 20, 'fast': {'input': 8, 'output': 40}},
    },
    'aliases': {},
}
DAY = datetime.date.today()
NOW = datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')


def record(model='claude-sonnet-5-5', usage=None, stamp=NOW, mid='m1', rid='r1'):
    message = {'model': model, 'usage': usage or {'input_tokens': 1_000_000, 'output_tokens': 0}}
    if mid is not None:
        message['id'] = mid
    row = {'timestamp': stamp, 'message': message}
    if rid is not None:
        row['requestId'] = rid
    return json.dumps(row)


class TodayCost(unittest.TestCase):
    def scan(self, *lines):
        with tempfile.TemporaryDirectory() as root:
            folder = os.path.join(root, 'project')
            os.makedirs(folder)
            with open(os.path.join(folder, 'session.jsonl'), 'w', encoding='utf-8') as handle:
                handle.write('\n'.join(lines) + '\n')
            return today_cost.summarize(root, DAY, TABLE)

    def test_prices_a_known_model(self):
        result = self.scan(record())
        self.assertEqual(result['requests'], 1)
        self.assertAlmostEqual(result['total'], 2.0)
        self.assertEqual(result['unpriced'], 0)

    def test_a_malformed_timestamp_skips_that_record_only(self):
        result = self.scan(record(stamp='not-a-time', mid='a'), record(stamp=42, mid='b'), record(mid='c'))
        self.assertEqual(result['requests'], 1)
        self.assertAlmostEqual(result['total'], 2.0)

    def test_malformed_lines_and_usage_are_skipped(self):
        broken = '{"usage": oops'
        odd = json.dumps({'timestamp': NOW, 'message': {'model': 'claude-sonnet-5-5', 'usage': 'none'}})
        listed = json.dumps(['usage'])
        result = self.scan(broken, odd, listed, record())
        self.assertEqual(result['requests'], 1)

    def test_records_without_ids_are_not_merged(self):
        result = self.scan(record(mid=None, rid=None), record(mid=None, rid=None))
        self.assertEqual(result['requests'], 2)
        self.assertAlmostEqual(result['total'], 4.0)

    def test_one_response_logged_per_block_counts_once(self):
        result = self.scan(record(), record())
        self.assertEqual(result['requests'], 1)

    def test_an_unknown_model_is_unpriced_not_free(self):
        result = self.scan(record(model='claude-future-9', mid='x'), record(mid='y'))
        self.assertEqual(result['requests'], 2)
        self.assertEqual(result['unpriced'], 1)
        self.assertAlmostEqual(result['total'], 2.0)

    def test_yesterday_is_left_out(self):
        yesterday = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=2)).isoformat()
        result = self.scan(record(stamp=yesterday, mid='old'), record(mid='new'))
        self.assertEqual(result['requests'], 1)

    def test_cache_writes_split_by_ttl(self):
        usage = {'input_tokens': 0, 'output_tokens': 0, 'cache_creation_input_tokens': 2_000_000,
                 'cache_creation': {'ephemeral_1h_input_tokens': 1_000_000, 'ephemeral_5m_input_tokens': 1_000_000}}
        self.assertAlmostEqual(today_cost.cost_of('claude-sonnet-5-5', usage, TABLE), 6.5)

    def test_long_prompt_tier_fast_mode_and_us_inference(self):
        long = {'input_tokens': 150_000, 'output_tokens': 0}
        self.assertAlmostEqual(today_cost.cost_of('claude-haiku-5-5', long, TABLE), 0.075)
        fast = {'input_tokens': 1_000_000, 'output_tokens': 0, 'speed': 'fast'}
        self.assertAlmostEqual(today_cost.cost_of('claude-opus-5-5', fast, TABLE), 8.0)
        self.assertIsNone(today_cost.cost_of('claude-sonnet-5-5', fast, TABLE))
        us = {'input_tokens': 1_000_000, 'output_tokens': 0, 'inference_geo': 'us'}
        self.assertAlmostEqual(today_cost.cost_of('claude-sonnet-5-5', us, TABLE), 2.2)

    def test_model_ids_with_platform_and_date_suffixes(self):
        for model in ['claude-sonnet-5-5-20260901', 'us.anthropic.claude-sonnet-5-5-v1:0', 'claude-sonnet-5-5@20260901', 'claude-sonnet-5-5[1m]']:
            self.assertEqual(today_cost.model_key(model, TABLE), 'sonnet-5-5', model)
        self.assertIsNone(today_cost.model_key('claude-sonnet-5', TABLE))
        self.assertIsNone(today_cost.model_key(None, TABLE))

    def test_cached_files_are_not_rescanned(self):
        with tempfile.TemporaryDirectory() as root:
            log = os.path.join(root, 'session.jsonl')
            with open(log, 'w', encoding='utf-8') as handle:
                handle.write(record() + '\n')
            cache = os.path.join(root, 'cache.json')
            first = today_cost.summarize(root, DAY, TABLE, cache)
            calls = []
            original = today_cost.scan_file
            today_cost.scan_file = lambda *args: calls.append(args) or original(*args)
            try:
                second = today_cost.summarize(root, DAY, TABLE, cache)
            finally:
                today_cost.scan_file = original
            self.assertEqual(first, second)
            self.assertEqual(calls, [])

    def test_no_price_table_is_an_error_not_a_zero(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(today_cost.main(['today_cost.py']), 2)
        self.assertEqual(json.loads(out.getvalue()), {'error': 'no price table given'})


if __name__ == '__main__':
    unittest.main()
