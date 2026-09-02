# 🔍 A real transaction, end to end

Every observed number in this tool comes from a transaction you can open. This
document follows one of them completely, so you can check the method by hand.

The interface links a proof on every observed row. This page explains what
those links prove and how the edge was derived.

---

## The transaction

| | |
|---|---|
| Hash | `0x63b964341f0b5ba7d59990db7e943045183214435f31f925458c62a6692d3a69` |
| Chain | Ethereum, chain id 1 |
| Block | 25881821 |
| Time | 2026-09-01T10:25:47Z |
| Status | success |
| Gas used | 1,414,274 |
| Sender | `0x756e078632fbddef083779852541d8def841c53f` (an externally owned account) |
| First callee | `0x334f5d28a71432f8fc21c7b2b6f5dbbcd8b32a7b` (`mstkeUSDC`) |
| Analysed target | `0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB` (`STEAKUSDC`, a MetaMorpho vault) |

Open it on a public explorer:

- [etherscan.io](https://etherscan.io/tx/0x63b964341f0b5ba7d59990db7e943045183214435f31f925458c62a6692d3a69)
- [eth.blockscout.com](https://eth.blockscout.com/tx/0x63b964341f0b5ba7d59990db7e943045183214435f31f925458c62a6692d3a69)

The complete trace is committed next to this page, so you can check every claim
below without a key and without an RPC provider:

- [`docs/examples/deposit-0x63b96434.trace.json`](examples/deposit-0x63b96434.trace.json) — 232 frames, as `trace_transaction` returned them.

Reproduce the analysis yourself:

```bash
bun run scripts/explain-tx.ts \
  0x63b964341f0b5ba7d59990db7e943045183214435f31f925458c62a6692d3a69 \
  0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB ethereum
```

---

## What the trace contains

| Fact | Value |
|---|---|
| Frames | 232 |
| Distinct addresses | 17 |
| Addresses with a direct call edge to or from the vault | 5 |
| Addresses that only co-occur, with no edge to the vault | 11 |
| Frames that enter the vault | 6, at trace paths `1,2,0` `1,4,0` `1,4,1` `1,11,1` `1,13,0` `1,13,1` |

That last row is the reason this tool exists. Eleven of seventeen addresses in
this transaction have nothing to do with the vault. A tool that treats "same
transaction" as a relationship would report eleven false counterparties.

---

## Inbound: who called the vault

The caller function comes from the **parent frame** of the frame that enters
the target. Nothing else can name it.

```text
[1,11]    mstkeUSDC 0x334f…2a7b   deposit(address,uint256)     ← parent frame
└── [1,11,1]  → STEAKUSDC 0xbeef…64cb   deposit(uint256,address)   ← enters the target
```

The four inbound edges this one transaction proves:

| Caller | Caller function | Target function | Call type | Frames |
|---|---|---|---|---|
| `mstkeUSDC 0x334f…2a7b` | `deposit(address,uint256)` | `deposit(uint256,address)` | call | 1 |
| `0xf73a…c09e` | `totalAssets(address)` | `balanceOf(address)` | staticcall | 2 |
| `0xf73a…c09e` | `totalAssets(address)` | `previewRedeem(uint256)` | staticcall | 2 |
| `0xf73a…c09e` | `maxDeposit(address)` | `maxDeposit(address)` | staticcall | 1 |

`0xf73a…c09e` is unverified, so it keeps its short address instead of a name.
Its function `totalAssets(address)` still resolves, because the selector
`0x4cdad506` was checked against a signature database and the candidate
re-hashed to the same four bytes.

---

## Outbound: what the vault called

An outbound edge is attributed to the target function that was executing when
the call left. The walk carries that selector down the tree.

```text
[1,11,1]  STEAKUSDC.deposit(uint256,address)          ← enclosing target function
  ├── [1,11,1,…]  → Morpho.idToMarketParams(bytes32)     staticcall   13 frames
  ├── [1,11,1,…]  → Morpho.extSloads(bytes32[])          staticcall   13 frames
  ├── [1,11,1,…]  → Morpho.market(bytes32)               staticcall   13 frames
  ├── [1,11,1,…]  → AdaptiveCurveIrm.borrowRateView(…)   staticcall   11 frames
  ├── [1,11,1,…]  → USDC.transferFrom(address,address,uint256)   call    1 frame
  ├── [1,11,1,…]  → Morpho.accrueInterest(…)             call          1 frame
  └── [1,11,1,…]  → Morpho.supply(…)                     call          1 frame
```

The same transaction also proves outbound edges from two view functions, which
were called by `0xf73a…c09e`:

| Target function | Destination | Destination function | Call type | Frames |
|---|---|---|---|---|
| `deposit(uint256,address)` | USDC | `transferFrom(address,address,uint256)` | call | 1 |
| `deposit(uint256,address)` | Morpho | `supply((address,address,address,address,uint256),uint256,uint256,address,bytes)` | call | 1 |
| `deposit(uint256,address)` | Morpho | `accrueInterest((address,address,address,address,uint256))` | call | 1 |
| `maxDeposit(address)` | Morpho | `extSloads(bytes32[])` | staticcall | 12 |
| `previewRedeem(uint256)` | Morpho | `idToMarketParams(bytes32)` | staticcall | 24 |
| `previewRedeem(uint256)` | AdaptiveCurveIrm | `borrowRateView(…)` | staticcall | 21 |

Read the first three rows together and you have the vault's deposit path in
one sentence: **the vault pulls USDC from the depositor, accrues interest on
the market, then supplies that USDC into Morpho.**

---

## How this becomes the interface

| Interface element | What this transaction contributes |
|---|---|
| `Calls into this contract` | the four inbound rows above, each with this hash as a proof link |
| `Calls from this contract` | the outbound rows above, grouped by target function |
| Function detail of `deposit(uint256,address)` | `USDC.transferFrom` and `Morpho.supply` marked **possible from code: yes** and **observed onchain: yes** |
| `Observed execution` | one of the transactions counted for `deposit` |
| Function graph | the middle column node `deposit()`, its left edge from `mstkeUSDC.deposit()`, and its right edges to `USDC.transferFrom()` and `Morpho.supply()` |

The counts in the interface are larger than the counts here, because a window
holds many transactions. This page shows one of them in full.

---

## Two caveats a reviewer should know

**An explorer's internal-transaction list is not the frame list.** Public
explorers usually show value transfers and state-changing internal calls.
A `staticcall` that only reads state may not appear. Most rows above are
staticcalls, so compare them against the committed trace JSON, or against a
trace-level view such as Blockscout, Otterscan or Tenderly, rather than the
summary list on a scanner page.

**One transaction is not a trend.** This page proves that an edge exists and
that the derivation is correct. It says nothing about how often the path runs.
For that, the interface states the scanned span, the covered blocks and the
traced sample on every screen.
