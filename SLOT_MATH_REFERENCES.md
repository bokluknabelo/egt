# Slot math implementation references

The local runtime is an original Node implementation. External repositories were
studied for architecture and validation patterns; their source is not vendored.

## Slotopol server

- Repository: https://github.com/slotopol/server
- Reviewed revision: `1bef3bb52b737c946aabae9aa2cc3ee7f5d1456a`
- License at review: MIT
- Adopted concepts: one random stop per circular reel, visible adjacent symbols,
  separate line/scatter scanners, exact enumeration, bonus-reel-first RTP
  composition, and selectable immutable reel sets.
- Local implementations: `egt-fixed-reel-engine.cjs`, `egt-exact-math.cjs`,
  `egt-feature-math.cjs`.

## StakeEngine math SDK

- Repository: https://github.com/StakeEngine/math-sdk
- Reviewed revision: `600a37657c75d67c0412bf3952a01d7e7ee99987`
- License at review: MIT
- Adopted concepts: separate base/free-game reel sets, explicit feature state,
  retrigger accounting, per-mode RTP allocation, offline optimization, and
  simulation as verification rather than the source of theoretical RTP.
- Local implementations: `egt-reel-optimizer.cjs`, `egt-feature-math.cjs`,
  `egt-family-math-specs.cjs`.

## kedoska/engine-slot

- Repository: https://github.com/kedoska/engine-slot
- Reviewed revision: `b50566e1d5bf84c81f916d8b57a6eda02d5bf5b9`
- License at review: GPL-2.0
- Used only as an architectural reference for configuration injection and
  persistent feature state. No source was copied into this project.

## EGT client assets

The extracted local client bundles and in-game help are authoritative only for
what they explicitly declare: visible symbol roles, line paths, presentation
rules, and protocol shapes. They do not expose authentic server reel mathematics
or jackpot contribution. Original configurations must therefore be labelled as
such and pass the total-RTP and runtime-protocol gates before selection.
