#!/usr/bin/env python3
"""Sync the common review player and styling from the instrument repository."""
import argparse
import ast
from pathlib import Path
import re

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('sampler', type=Path, help='Path to the native sampler checkout')
parser.add_argument('--check', action='store_true', help='Check without writing')
args = parser.parse_args()
source = args.sampler / 'tools/audition'
target = Path(__file__).resolve().parent / 'review'
for name in ['app.js', 'style.css']:
    expected = (source / name).read_bytes()
    if args.check:
        if (target / name).read_bytes() != expected:
            raise SystemExit(f'{name} differs; run this command without --check')
    else:
        (target / name).write_bytes(expected)
# Both entry pages and backends must understand the same saved issue codes.
module = ast.parse((args.sampler / 'tools/audition.py').read_text())
reasons = next(ast.literal_eval(node.value) for node in module.body if isinstance(node, ast.Assign) and any(isinstance(name, ast.Name) and name.id == 'REASONS' for name in node.targets))
for path in [source / 'index.html', target / 'index.html']:
    issues = re.search(r'id="issues">(.*?)</div>', path.read_text(), re.S)[1]
    if set(re.findall(r'value="([a-z-]+)"', issues)) != set(reasons):
        raise SystemExit(f'Issue choices differ in {path}')
browser = re.search(r'export const REASONS = new Set\(\[(.*?)\]\)', (target / 'library.js').read_text())[1]
if set(re.findall(r"'([a-z-]+)'", browser)) != set(reasons):
    raise SystemExit('Browser backend issue choices differ')
print('Shared player, styling and issue choices match.')
