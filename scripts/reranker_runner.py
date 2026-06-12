#!/usr/bin/env python3
"""Forwarding shim — the CANONICAL runner lives in packages/coretex/scripts/reranker_runner.py
(shipped inside the @botcoin/coretex package). NEVER duplicate the runner source here."""
import os
import sys

_CANONICAL = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "packages", "coretex", "scripts", "reranker_runner.py",
)
os.execv(sys.executable, [sys.executable, _CANONICAL] + sys.argv[1:])
