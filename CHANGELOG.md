# Changelog

All notable changes to AgentWallet for Radix will be documented here.

## [2.0.0] — 2026-05-29

### Added
- Caviar QuantaSwap adapter — add/remove liquidity with concentrated bins
- Ociswap PrecisionPool adapter — add/remove liquidity with tick ranges
- DefiPlaza adapter — add/remove liquidity, shortage detection, co-token support
- Caviar LSU Pool dedicated tools — `wallet_lsu_add` / `wallet_lsu_remove`
- WEFT Finance adapter — Supply, Withdraw, Create CDP, Borrow, Repay, Remove Collateral, Health
- `known-pools.ts` — single source of truth: 130 pools + 32 tokens + helpers
- `network-config.ts` — network configuration extracted from AgentWallet
- `wallet_get_pool_info` — dynamic pool info with WeightedPool vs Ociswap detection
- `wallet_get_pair_state` — DefiPlaza pair state query tool
- NFT LP receipt support for QuantaSwap and PrecisionPool remove liquidity

### Fixed
- `safeDecimal` / `safeDecimalCeil` — uses token divisibility from known-pools registry
- `wallet_balance` — returns `resources` with addresses and `nfts` with correct labels
- `wallet_remove_liquidity` — auto-detects LP token from vault, passes `lpNftId` to adapters
- Token order detection in Caviar QuantaSwap — X/Y contract order resolved from Gateway vaults
- Royalty fee (1 XRD) discounted from effective amount when token is XRD in `transfer_liquidity`
- `weftWithdraw` — correct w2-token address
- `weftManageCdp` — validates empty addresses
- CDP health timeout 15s
- NFT labels correct in balance response
- `wallet_get_pool_info` — timeout and correct WeightedPool vs Ociswap detection
- Swap `amount` / `maxSlippage` — accepts string and number
- `liquidity.ts` — migrated from 3 separate KNOWN_POOLS registries to unified KNOWN_POOLS_REGISTRY
- DefiPlaza co-token manifest — replaced `transfer_batch` with two `transfer_liquidity` calls

### Removed
- `config.ts` — eliminated, replaced by `network-config.ts`
- `KNOWN_POOLS`, `KNOWN_PRECISION_POOLS`, `KNOWN_QUANTASWAP_POOLS` — replaced by `KNOWN_POOLS_REGISTRY`

---

## [1.0.0] — 2026-05-10

### Added
- Staking adapter — Stake / Unstake XRD with validator
- Claim stake tool — claim unstaked XRD after unbonding period
- TwoPool adapter — Caviar WeightedPool add/remove liquidity
- TwoPool adapter — Ociswap BasicPool add/remove liquidity
- `wallet_lsu_add` / `wallet_lsu_remove` tools for Caviar LSU Pool
- Swap integration via AGGRClient — Astrolescent and private AGGR
- Conditional orders — price-triggered swaps
- Badge management — issue, revoke, renew agent badges
- Multi-asset support expanded: LSU tokens, DFP2, ASTRL and custom assets

### Fixed
- PolicyVault royalty handling — correct XRD deduction per operation
- RadixClient transaction polling — improved status detection
- AGGRClient — retry logic on timeout

---

## [0.1.0] — 2026-05-04

### Added
- PolicyVault Scrypto contract with multi-asset support
- NFT agent badge with expiration, revocation and renewal
- Two-level spend limits: max per transaction and daily cap
- Emergency freeze and unfreeze
- Multisig support for large transfers with owner approval
- On-chain audit log via Scrypto events
- Package royalties — 0.25 XRD per operation
- Developer fee vault — 0.20% on swaps
- AgentWallet TypeScript SDK
- AGGRClient — supports Astrolescent and private AGGR instances
- RadixClient — transaction signing and submission
- LangChain-compatible tools: balance, transfer, swap, conditional orders
- Badge management tools: issue, revoke, renew
- Multi-asset support: XRD, HUSDC, HUSDT, HWBTC, HETH
- Custom asset registration via registerAsset()
- Support for mainnet, stokenet
