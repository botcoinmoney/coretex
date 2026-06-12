"""TS <-> Python wire-grammar parity (cleanup-audit R10).

cortex-py is the dev-only cross-impl harness; packages/cortex/src is the
launch reference implementation. These tests parse the PATCH_TYPE and RANGES
tables out of state/types.ts and assert they equal this package's constants,
so a one-sided edit (e.g. a new patch type or region) is a failing test
instead of silent drift. Skipped when the TS tree is absent (standalone
package install).
"""
import os
import re

import pytest

from cortex_py.types import PATCH_TYPE, RANGES

_TS_TYPES_PATH = os.path.join(
    os.path.dirname(__file__),
    "..", "..", "..", "cortex", "src", "state", "types.ts",
)

requires_ts = pytest.mark.skipif(
    not os.path.exists(_TS_TYPES_PATH), reason="packages/cortex/src not present"
)


def _public_ints(cls):
    return {k: v for k, v in vars(cls).items() if not k.startswith("_") and isinstance(v, int)}


def _ts_source():
    with open(_TS_TYPES_PATH, "r", encoding="utf-8") as f:
        return f.read()


@requires_ts
def test_patch_type_parity():
    ts = _ts_source()
    block = re.search(r"export const PATCH_TYPE = \{(.*?)\} as const", ts, re.S).group(1)
    ts_table = {
        name: int(value, 16)
        for name, value in re.findall(r"(\w+):\s*(0x[0-9a-fA-F]+)", block)
    }
    assert ts_table == _public_ints(PATCH_TYPE)


@requires_ts
def test_ranges_parity():
    ts = _ts_source()
    block = re.search(r"export const RANGES = \{(.*?)\} as const", ts, re.S).group(1)
    ts_table = {}
    for name, value in re.findall(r"(\w+):\s*(\d+)\s*,", block):
        # Stride-1 overlay lines declare two entries per line; findall handles both.
        ts_table[name] = int(value)
    assert ts_table == _public_ints(RANGES)
