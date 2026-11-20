# Blaze Cache — Documentation

This folder holds project-level documents, grouped by category. Package-level API docs
live in each package's own `README.md`, and the main entry point is the
[root README](../README.md).

## Folder structure

```text
docs/
├── README.md                                   # this index
├── assets/
│   └── blaze-cache-logo.png                    # project logo
└── security/
    └── security-assessment-2026-11-20.md       # vulnerability assessment of 0.4.0-beta.2
```

## Documents

| Category | Document | Version / date | Description |
|---|---|---|---|
| Security | [Vulnerability Assessment](security/security-assessment-2026-11-20.md) | 2026-11-20, `0.4.0-beta.2` | Dependency, secret, CI/CD, Wasm memory-safety and application-design review with findings and status. |
| Assets | [Blaze Cache logo](assets/blaze-cache-logo.png) | — | Used by the root README and package READMEs. |

## Conventions

- Group documents into category folders: `security/`, `assets/`, and add new folders as
  new categories appear (for example, `plan/` or `architecture/`).
- Name dated assessments `security/security-assessment-YYYY-MM-DD.md`.
- Record the baseline version and target version in the document header.
- Link new documents from this index in the same change that adds them.
