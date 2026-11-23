# Blaze Cache — Documentation

This folder holds project-level documents, grouped by category. Package-level API docs
live in each package's own `README.md`, and the main entry point is the
[root README](../README.md). The root [Code of Conduct](../CODE_OF_CONDUCT.md) governs all
community participation.

## Folder structure

```text
docs/
├── README.md                                   # this index
├── assets/
│   └── blaze-cache-logo.png                    # project logo
├── benchmarks/
│   └── RESULTS.md                              # published Node + browser benchmark results
├── plan/
│   ├── 0.4.0-roadmap.md                        # 0.4.0 release plan (staged under 0.4.0-beta.3)
│   └── 0.5.0-roadmap.md                        # 0.5.0 devtools + large-data core plan (beta → beta.4 → rc.1)
└── security/
    └── security-assessment-2026-11-20.md       # vulnerability assessment of 0.4.0-beta.2
```

## Documents

| Category   | Document                                                               | Version / date                              | Description                                                                                                                                                               |
| ---------- | ---------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan       | [0.4.0 Roadmap](plan/0.4.0-roadmap.md)                                 | Target `0.4.0`, staged under `0.4.0-beta.3` | Planned 0.4.0 changes: benchmarks, hybrid/zero-copy memory, multi-tab sync and a final data-driven speed-optimization stage, with stage sequence and acceptance criteria. |
| Plan       | [0.5.0 Roadmap](plan/0.5.0-roadmap.md)                                 | Target `0.5.0`, beta → `beta.4` → `rc.1`    | Planned devtools packages plus the indexed query API and opt-in tiered offline storage: staged feature freeze, scope valve, browser tests, final-test matrix.             |
| Security   | [Vulnerability Assessment](security/security-assessment-2026-11-20.md) | 2026-11-20, `0.4.0-beta.2`                  | Dependency, secret, CI/CD, Wasm memory-safety and application-design review with findings and status.                                                                     |
| Benchmarks | [Published Results](benchmarks/RESULTS.md)                             | 2026-11-20, `0.4.0-beta.3` Stage 1          | Node + browser numbers across five payload sizes and two value representations, raw JSON, methodology and the boundary-cost caveat.                                       |
| Assets     | [Blaze Cache logo](assets/blaze-cache-logo.png)                        | —                                           | Used by the root README and package READMEs.                                                                                                                              |

## Conventions

- Group documents into category folders: `plan/`, `security/`, `assets/`, and add new
  folders as new categories appear (for example, `architecture/`).
- Name planning documents after the release they target (for example,
  `plan/0.4.0-roadmap.md`).
- Name dated assessments `security/security-assessment-YYYY-MM-DD.md`.
- Record the baseline version and target version in the document header.
- Link new documents from this index in the same change that adds them.
