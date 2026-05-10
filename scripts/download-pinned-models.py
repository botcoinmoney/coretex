#!/usr/bin/env python3
"""Download pinned BGE-M3, Qwen3-Reranker-0.6B, and MemReranker-4B and verify
per-file SHA-256 matches the bundle manifest in packages/cortex/src/bundle/index.ts.

Usage: download-pinned-models.py <cache-dir> <model-id>

Reads HF_ACCESS_TOKEN from env. Writes to <cache-dir>/<modelId>@<revision>/.
"""
import hashlib
import json
import os
import sys
from pathlib import Path

from huggingface_hub import hf_hub_download

PINS = {
    'BAAI/bge-m3': {
        'revision': '5617a9f61b028005a4858fdac845db406aefb181',
        'files': [
            ('1_Pooling/config.json', 'e54c164a07274f2eb45bb724f54a79d1efcc90c41573887cd9a29aeee0597352', 191),
            ('colbert_linear.pt', '19bfbae397c2b7524158c919d0e9b19393c5639d098f0a66932c91ed8f5f9abb', 2100674),
            ('config.json', '26159e7ad065073448460117eb24b7a4572f6f4e78eadff65dc0a11c052449fa', 687),
            ('config_sentence_transformers.json', '1eef72430e7194a1e59680e635aed81ffa083f05668dbc5bb1c56c04c0999c38', 123),
            ('modules.json', '84e40c8e006c9b1d6c122e02cba9b02458120b5fb0c87b746c41e0207cf642cf', 349),
            ('pytorch_model.bin', 'b5e0ce3470abf5ef3831aa1bd5553b486803e83251590ab7ff35a117cf6aad38', 2271145830),
            ('sentence_bert_config.json', 'eb9b44b13c0f52a3b3685c3b1cbdea1ba8b04bea123b98f61610048940776eb1', 54),
            ('sentencepiece.bpe.model', 'cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865', 5069051),
            ('sparse_linear.pt', '45c93804d2142b8f6d7ec6914ae23a1eee9c6a1d27d83d908a20d2afb3595ad9', 3516),
            ('special_tokens_map.json', '8c785abebea9ae3257b61681b4e6fd8365ceafde980c21970d001e834cf10835', 964),
            ('tokenizer.json', '21106b6d7dab2952c1d496fb21d5dc9db75c28ed361a05f5020bbba27810dd08', 17098108),
            ('tokenizer_config.json', 'a62b2b6784f990259fddef5f16388693a8043be4f69179e6a5257eeb3f9abac4', 444),
        ],
    },
    'Qwen/Qwen3-Reranker-0.6B': {
        'revision': 'e61197ed45024b0ed8a2d74b80b4d909f1255473',
        'files': [
            ('config.json', 'd479c427a9ca5295218063d4f9aca4f297ab4ac27487cca7af42c84643d51ef0', 727),
            ('config_sentence_transformers.json', '6a153d6696f78fd588c1c728967f0b773ea869d3c6028f151ce71ebe49140762', 325),
            ('generation_config.json', '81051cd3f6e77013827148d0b8a6ead93f8ac390d5ab805f849199f0af6a08db', 214),
            ('modules.json', '6f13b6b4a89e577b591b2077bca40c67c26541a6740a8809267cb474f90806a9', 280),
            ('sentence_bert_config.json', '3234ebd224d492cbe8d55d5ec80a3f408451c4db3005bafb64fe1c51c763e01e', 362),
            ('tokenizer_config.json', '253153d0738ceb4c668d2eff957714dd2bea0b56de772a9fdccd96cbf517e6a0', 9706),
            ('vocab.json', 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910', 2776833),
            ('merges.txt', '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5', 1671853),
            ('tokenizer.json', 'aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4', 11422654),
            ('model.safetensors', '27cd75a405b9c1b46b59abfd88aaa209e6fed2a1972cde9b70e7659537c5e65b', 1191588280),
            ('1_LogitScore/config.json', '73e3156450564d8a98b7e47bcf5aace0f29600828b51937da545571e84db3ff3', 57),
            ('chat_template.jinja', '6f682162495ec5b39fd9005c01b6aa2a74669379fe967039f1e2cbbe8752369d', 741),
        ],
    },
    'IAAR-Shanghai/MemReranker-4B': {
        'revision': '7fe33c1385f652f52d370b8822d6b620b32b6ec4',
        'files': [
            ('1_LogitScore/config.json', '73e3156450564d8a98b7e47bcf5aace0f29600828b51937da545571e84db3ff3', 57),
            ('chat_template.jinja', '6f682162495ec5b39fd9005c01b6aa2a74669379fe967039f1e2cbbe8752369d', 741),
            ('config.json', '82d53bdb18bfab8cd5ec620710f1561903dfdbdf8f5cf81d2237f7fa62766502', 1593),
            ('config_sentence_transformers.json', '6a153d6696f78fd588c1c728967f0b773ea869d3c6028f151ce71ebe49140762', 325),
            ('generation_config.json', 'ba8396a48fbb26b33af6cdf4463ec064e5f3b692bf5eb0ca1c9d964df377cf2d', 213),
            ('model.safetensors', '48aef1a3c826aabaf8a3852d3d5122ebd456d166ae3e1e401279fc82c15e0ec2', 8820160440),
            ('modules.json', '6f13b6b4a89e577b591b2077bca40c67c26541a6740a8809267cb474f90806a9', 280),
            ('sentence_bert_config.json', '3234ebd224d492cbe8d55d5ec80a3f408451c4db3005bafb64fe1c51c763e01e', 362),
            ('special_tokens_map.json', '76862e765266b85aa9459767e33cbaf13970f327a0e88d1c65846c2ddd3a1ecd', 613),
            ('tokenizer.json', 'be75606093db2094d7cd20f3c2f385c212750648bd6ea4fb2bf507a6a4c55506', 11422650),
            ('tokenizer_config.json', '579073f506a3f85caed232bb91617cfb93028408d1f43ffaf66f3fc1aee9a9af', 348),
        ],
    },
}


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    if len(sys.argv) != 3:
        print('usage: download-pinned-models.py <cache-dir> <model-id>', file=sys.stderr)
        return 2
    cache_dir = Path(sys.argv[1]).resolve()
    model_id = sys.argv[2]
    if model_id not in PINS:
        print(f'unknown model {model_id}; known: {list(PINS)}', file=sys.stderr)
        return 2

    cache_dir.mkdir(parents=True, exist_ok=True)
    pin = PINS[model_id]
    revision = pin['revision']
    token = os.environ.get('HF_ACCESS_TOKEN') or os.environ.get('HUGGING_FACE_HUB_TOKEN')

    print(f'[{model_id}@{revision[:8]}] starting…', flush=True)
    results = []
    failures = []
    for rel_path, expected_sha, expected_bytes in pin['files']:
        try:
            local = hf_hub_download(
                repo_id=model_id,
                filename=rel_path,
                revision=revision,
                cache_dir=str(cache_dir),
                token=token,
                local_dir=None,
            )
        except Exception as e:
            failures.append((rel_path, f'download error: {e}'))
            continue
        local_path = Path(local)
        actual_bytes = local_path.stat().st_size
        if actual_bytes != expected_bytes:
            failures.append((rel_path, f'size mismatch: {actual_bytes} != {expected_bytes}'))
            continue
        actual_sha = sha256_of(local_path)
        if actual_sha != expected_sha:
            failures.append((rel_path, f'sha256 mismatch: {actual_sha} != {expected_sha}'))
            continue
        results.append({'file': rel_path, 'sha256': actual_sha, 'bytes': actual_bytes, 'cached_at': str(local_path)})
        print(f'[{model_id}@{revision[:8]}] OK {rel_path} ({actual_bytes:,}B)', flush=True)

    if failures:
        print(f'[{model_id}] FAILED:', file=sys.stderr)
        for f, msg in failures:
            print(f'  {f}: {msg}', file=sys.stderr)
        return 1

    summary = {
        'modelId': model_id,
        'revision': revision,
        'files': results,
    }
    out_dir = cache_dir / 'verified'
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f'{model_id.replace("/", "__")}.json'
    out_path.write_text(json.dumps(summary, indent=2, sort_keys=True))
    print(f'[{model_id}] verified {len(results)} files; summary at {out_path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
