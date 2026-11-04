"""Prints today's API-rate cost over every Claude Code session log, as JSON.

Session logs can exceed the 4 MiB a mod may read, so the mod runs this instead.
The rates come from the mod as JSON in the first argument (hooks/pricing.ts is
the one table); without them nothing can be priced and the script says so.

Each record is read on its own: one malformed line, timestamp or usage block
is skipped, never the whole total. A request whose model has no known price is
counted under `unpriced`, so the total can say it is partial. Per-file results
are cached by size and modification time, so a refresh rescans only the logs
that changed.
"""
import datetime
import glob
import hashlib
import json
import os
import re
import sys
import tempfile


def model_key(model, table):
    """The table key for a model id, as hooks/pricing.ts modelKey finds it."""
    if not isinstance(model, str):
        return None
    found = re.search(r'claude-(.+)$', re.sub(r'\[[^\]]*\]$', '', model.lower()))
    if not found:
        return None
    key = found.group(1)
    key = re.sub(r'@.*$', '', key)
    key = re.sub(r'-v\d+(?::\d+)?$', '', key)
    key = re.sub(r'-\d{8}$', '', key)
    key = re.sub(r'-latest$', '', key)
    key = table['aliases'].get(key, key)
    return key if key in table['prices'] else None


def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 else 0


def cost_of(model, usage, table):
    """A request's API-rate cost, as hooks/pricing.ts costOf works it out; None when unknown."""
    key = model_key(model, table)
    if key is None:
        return None
    price = table['prices'][key]
    fresh = number(usage.get('input_tokens'))
    read = number(usage.get('cache_read_input_tokens'))
    written = number(usage.get('cache_creation_input_tokens'))
    out = number(usage.get('output_tokens'))
    rates = price
    over = price.get('over')
    if over and fresh + read + written > over['tokens']:
        rates = over['rates']
    if usage.get('speed') == 'fast':
        fast = price.get('fast')
        if not fast:
            return None
        scale = fast['input'] / rates['input']
        rates = {
            'input': fast['input'],
            'output': fast['output'],
            'write5m': rates['write5m'] * scale,
            'write1h': rates['write1h'] * scale,
            'read': rates['read'] * scale,
        }
    split = usage.get('cache_creation')
    long_writes = min(number(split.get('ephemeral_1h_input_tokens')) if isinstance(split, dict) else 0, written)
    geo = 1.1 if price.get('geo') and usage.get('inference_geo') == 'us' else 1
    return (
        fresh * rates['input']
        + long_writes * rates['write1h']
        + (written - long_writes) * rates['write5m']
        + read * rates['read']
        + out * rates['output']
    ) * geo / 1e6


def local_day(stamp):
    """The person's own day for a UTC timestamp, or None when it can't be read."""
    if not isinstance(stamp, str):
        return None
    try:
        return datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00')).astimezone().date()
    except ValueError:
        return None


def scan_file(path, day, table):
    """Today's figures in one log: total, requests, and requests with no known price."""
    total = 0.0
    requests = 0
    unpriced = 0
    seen = set()
    try:
        lines = open(path, encoding='utf-8', errors='ignore')
    except OSError:
        return {'total': 0.0, 'requests': 0, 'unpriced': 0}
    with lines:
        for line in lines:
            if '"usage"' not in line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if not isinstance(row, dict):
                continue
            message = row.get('message')
            usage = message.get('usage') if isinstance(message, dict) else None
            if not isinstance(usage, dict) or local_day(row.get('timestamp')) != day:
                continue
            # A response is logged once per content block. Its ids say which
            # lines are one response; a line without them is counted alone.
            ids = (message.get('id'), row.get('requestId'))
            if ids != (None, None):
                if ids in seen:
                    continue
                seen.add(ids)
            requests += 1
            cost = cost_of(message.get('model'), usage, table)
            if cost is None:
                unpriced += 1
            else:
                total += cost
    return {'total': total, 'requests': requests, 'unpriced': unpriced}


def summarize(root, day, table, cache_path=None):
    start = datetime.datetime.combine(day, datetime.time()).timestamp()
    stamp = hashlib.sha256((json.dumps(table, sort_keys=True) + day.isoformat()).encode()).hexdigest()[:16]
    cache = {}
    if cache_path:
        try:
            with open(cache_path, encoding='utf-8') as handle:
                kept = json.load(handle)
            if isinstance(kept, dict) and kept.get('stamp') == stamp and isinstance(kept.get('files'), dict):
                cache = kept['files']
        except (OSError, ValueError):
            cache = {}
    files = {}
    for path in glob.glob(os.path.join(root, '**', '*.jsonl'), recursive=True):
        try:
            info = os.stat(path)
        except OSError:
            continue
        if info.st_mtime < start:
            continue
        mark = [info.st_size, info.st_mtime]
        known = cache.get(path)
        if isinstance(known, dict) and known.get('mark') == mark:
            files[path] = known
        else:
            files[path] = {'mark': mark, **scan_file(path, day, table)}
    if cache_path:
        try:
            with open(cache_path, 'w', encoding='utf-8') as handle:
                json.dump({'stamp': stamp, 'files': files}, handle)
        except OSError:
            pass
    return {
        'day': day.isoformat(),
        'total': sum(one['total'] for one in files.values()),
        'requests': sum(one['requests'] for one in files.values()),
        'unpriced': sum(one['unpriced'] for one in files.values()),
    }


def main(argv):
    try:
        table = json.loads(argv[1])
        table['prices'], table['aliases']
    except (IndexError, ValueError, TypeError, KeyError):
        print(json.dumps({'error': 'no price table given'}))
        return 2
    day = datetime.date.today()
    cache_path = os.path.join(tempfile.gettempdir(), f'agent-trace-today-{os.getuid() if hasattr(os, "getuid") else "user"}.json')
    print(json.dumps(summarize(os.path.expanduser('~/.claude/projects'), day, table, cache_path)))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
