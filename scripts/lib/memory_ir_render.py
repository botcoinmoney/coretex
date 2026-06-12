"""Python replica of the protocol-owned Memory-IR render grammar.

Byte-identical to packages/coretex/src/eval/memory-ir-render.ts (renderMemoryIRDoc). The trainer renders the
candidate document with this so train-time text == serve-time text. A golden test
(scripts/test-memory-ir-render-golden.mjs) asserts equality with the TS/JS renderer on a fixed candidate set.

Field order (fixed): lifecycle ; role ; path ; conflict ; scope ; evidence ; density. Defaults omitted.
"""
import json
import sys


def render_memory_ir_header(ir):
    if not ir:
        return None
    parts = []
    lc = ir.get("lifecycle")
    if lc and lc != "none":
        parts.append(f"lifecycle={lc}")
    role = ir.get("evidence_role")
    if role and role != "none":
        parts.append(f"role={role}")
    path = [p for p in (ir.get("relation_path") or []) if isinstance(p, str) and len(p) > 0]
    if path:
        parts.append("path=" + ",".join(sorted(set(path))))
    conflict = ir.get("conflict_state")
    if conflict and conflict != "none":
        parts.append(f"conflict={conflict}")
    scope = ir.get("scope_match")
    if scope is True:
        parts.append("scope=match")
    elif scope is False:
        parts.append("scope=differs")
    if ir.get("has_public_evidence_path") is True:
        parts.append("evidence=true")
    density = ir.get("answer_density")
    if isinstance(density, (int, float)) and not isinstance(density, bool) and density > 0:
        parts.append(f"density={int(density)}")
    if not parts:
        return None
    return "[memory_ir " + "; ".join(parts) + "]"


def render_memory_ir_doc(ir, candidate_text):
    header = render_memory_ir_header(ir)
    return f"{header}\n{candidate_text}" if header else candidate_text


# CLI golden-test mode: read JSON array of {ir, candidate_text} on stdin, print one rendered doc per line
# (newlines inside a doc are escaped as \n so each example is one output line).
if __name__ == "__main__":
    items = json.load(sys.stdin)
    for it in items:
        out = render_memory_ir_doc(it.get("ir"), it.get("candidate_text", ""))
        sys.stdout.write(out.replace("\n", "\\n") + "\n")
