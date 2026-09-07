# Changelog

## [v0.1.0] - 2026-09-07

Initial public release of the DSH memory plugin — three host plugins for
[DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`),
zero dependencies, zero build step.

- **`dsh-memory-plugin`** (L1): cross-session short-term memory — hook-driven
  capture + recall. Captures each turn on `agent/turn-stopping` into a
  per-session Markdown digest, and injects the recent digest as background
  context on `agent/session-start`.
- **`dsh-memory-plugin/save`**: `memory_save` model tool — writes a
  self-contained concept page into `<dir>/memory/knowledge/`.
- **`dsh-memory-plugin/timer`**: `memory-timer` scheduled maintenance task
  (default 02:00 wall-clock, dry-run safe).
