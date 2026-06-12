#!/usr/bin/env python3
"""Run a subprocess with /root/coretex/.env loaded into its environment, without
ever echoing values to stdout/stderr. Treats the .env as opaque KEY=VALUE
lines (ignores blank lines and # comments). Exits with the child's exit code.

Usage: run-with-env.py [--env-file PATH] -- <cmd> [args...]
"""
import os
import sys
from pathlib import Path

ENV_PATH = Path('/root/coretex/.env')


def parse_env(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith('#'):
            continue
        if '=' not in s:
            continue
        k, _, v = s.partition('=')
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if not k or not k.replace('_', '').replace('-', '').isalnum():
            continue
        if k[0].isdigit():
            continue
        out[k] = v
    return out


def main() -> int:
    argv = sys.argv[1:]
    env_path = ENV_PATH
    if argv and argv[0] == '--env-file':
        env_path = Path(argv[1])
        argv = argv[2:]
    if argv and argv[0] == '--':
        argv = argv[1:]
    if not argv:
        print('usage: run-with-env.py [--env-file PATH] -- <cmd> [args...]', file=sys.stderr)
        return 2
    if not env_path.exists():
        print(f'env file not found: {env_path}', file=sys.stderr)
        return 2

    env_loaded = parse_env(env_path.read_text())
    new_env = {**os.environ, **env_loaded}
    # Never print values; just print the names that we loaded.
    print(f'[run-with-env] loaded {len(env_loaded)} keys from {env_path}: ' + ', '.join(sorted(env_loaded)),
          file=sys.stderr, flush=True)

    # exec replaces the current process so the child sees the env as if launched
    # directly with the env merged. We use os.execvpe to avoid printing values
    # via shell echo / set / env commands.
    try:
        os.execvpe(argv[0], argv, new_env)
    except FileNotFoundError as e:
        print(f'cannot exec {argv[0]}: {e}', file=sys.stderr)
        return 127


if __name__ == '__main__':
    sys.exit(main())
