# Package Overview

## Purpose

This add-on layers clean package lookup onto the previously shared FC handoff database without exposing the raw package-curation workflow.

It is designed for:
- package-aware route selection
- package-detail retrieval
- package readiness checks
- FC package history lookup

It is not designed for:
- raw package import
- package review queues
- source-audit reconstruction
- policy-review workflows

## Dependency

This package pack does not replace the original FC handoff. It is an overlay on top of the previously shared clean FC handoff database and handoff folder.

## Runtime Intent

The developer should use:
- `fc.v_package_runtime_lookup` as the primary runtime package surface
- `fc.v_package_case_history` as historical evidence only

If a package does not resolve, the correct outcome is:
- `no package exists`
