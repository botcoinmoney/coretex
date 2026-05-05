# Cortex Receipt Field Mapping (V0)

Public version of [`../specs/receipt_field_mapping.md`](../specs/receipt_field_mapping.md).

## Why field reuse

Cortex receipts ride the **existing `BotcoinMining` EIP-712 domain** so the contract code, ABI, and signer schema are unchanged for V0. The discriminator is `rulesVersion = 0xC0`. Block explorers will see the existing field labels (`docHash`, `questionsHash`, etc.); the Cortex meaning is by convention.

| `BotcoinMining` field   | Cortex meaning                                                                |
|-------------------------|-------------------------------------------------------------------------------|
| `worldSeed` (uint128)   | u128 of `keccak(H_e ‖ miner ‖ solveIndex ‖ parentStateRoot)`                   |
| `docHash`               | `parentStateRoot`                                                              |
| `questionsHash`         | `experienceCorpusRoot`                                                         |
| `constraintsHash`       | `shardCommitment`                                                              |
| `answersHash`           | `patchHash`                                                                    |
| `rulesVersion`          | `0xC0` (reserved Cortex value)                                                 |

## Sample explorer-decoder

JavaScript snippet — drop into any block explorer or auditor tool:

```js
function decodeCortexReceipt(receipt) {
  if (Number(receipt.rulesVersion) !== 0xC0) {
    return { lane: 'swcp', raw: receipt };
  }
  return {
    lane: 'cortex',
    miner: receipt.miner,
    epochId: BigInt(receipt.epochId),
    solveIndex: BigInt(receipt.solveIndex),
    worldSeed: BigInt(receipt.worldSeed),

    // Cortex meaning
    parentStateRoot: receipt.docHash,
    experienceCorpusRoot: receipt.questionsHash,
    shardCommitment: receipt.constraintsHash,
    patchHash: receipt.answersHash,

    rulesVersion: receipt.rulesVersion,
    signature: receipt.signature,
  };
}
```

## Worked example

A Cortex receipt for `(miner=0xabcd..., epoch=812, solveIndex=5)` would have:

```
worldSeed       = keccak("Hₑ ‖ 0xabcd... ‖ 5 ‖ <parentStateRoot>")[:16]
docHash         = parentStateRoot              (e.g. 0x4f...)
questionsHash   = experienceCorpusRoot         (e.g. 0x2a...)
constraintsHash = shardCommitment              (e.g. 0x9b...)
answersHash     = patchHash = keccak(compactPatchBytes)
rulesVersion    = 0xC0
```

The signature is over the same EIP-712 hash structure as a SWCP receipt — the contract validates only the signature and the increment of `nextIndex` / `lastReceiptHash`. It does not introspect field semantics.

## V1 path

`BotcoinMining.submitCortexReceipt(...)` sister function with explicit Cortex field names. Removes the receipt-field overloading without changing storage layout. Tracked in [`v1-roadmap.md`](./v1-roadmap.md).
