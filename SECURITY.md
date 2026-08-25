# Security Notes

Spectre Terminal is a local, read-only Polymarket intelligence tool. It does not sign transactions, store private keys or seed phrases, submit orders, or enable live trading, Shadow Bot, wallet signing, or CLOB execution.

## Historical credential incident

An obsolete credential was previously exposed in repository history. Treat any affected credential as revoked and do not copy or reproduce it, even if the related files are no longer in the current tree.

Rotate any affected credential through the provider dashboard. Removing a file from the current tree does not remove a credential from Git history. History cleanup is a separate operation; this task does not rewrite history or force-push.

CI runs a local secret-pattern scan over the checkout. If it detects a likely secret, the scanner reports only the relative path and detection type, never the matched value.

## Wallet tracker privacy

Runtime tracker settings belong in the ignored `data/tracker_config.json`. Start from `tracker_config.example.json`; the runtime default is `minUsd: 1000` with no tracked wallets. The loader can migrate a legacy root `tracker_config.json` into the runtime location only when the runtime file is absent, and never deletes the legacy file automatically.

## Owner actions

- Revoke/rotate any affected historical credential.
- Clean the Git history separately with `git filter-repo`, then coordinate any required force-push with repository owners.
- Enable GitHub Secret Scanning and Dependabot.
- Enable branch protection for `main`.
