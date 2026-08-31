---
name: dsh-evolve-integration
description: "Use when handling dsh-evolve integration in DSHOME; covers v0.4.2 install, bsdtar backup, smoke checklist, and memory panel placement decisions. · refined v1.1.0 (1 refinement)"
version: 1.1.0
author: dsh-evolve (crystallized)
license: MIT
---

# dsh-evolve-integration

> Auto-crystallized by dsh-evolve from memory tag `dsh-evolve`.
> This is a normal SKILL.md now — refine the prose freely. dsh-evolve
> appends future evidence as new "Refinement" sections below and never
> overwrites your edits.

dsh-evolve v0.4.2 is installed as an active plugin in the DSHOME dshome profile (2026-08-31); the memory panel stays at the settings entry, and backups use bsdtar.

## Current state
- Plugin status: active
- 22 memory/skill tools registered successfully
- Loaded into: DSHOME dshome profile

## Backup and smoke test
- Use `bsdtar` for dsh-evolve backups.
- The development launcher (`开发启动.cmd`) has already been updated to prepend `System32` to PATH, which fixes GNU tar's Windows path defect.
- Smoke checklist lives at `docs/DSHOME-EVOLVE-SMOKE.md`.

## Memory panel placement decision
- User decision (2026-08-31): do not move the memory panel to the “对话/轨迹” area for now; keep it at the Settings page entry.
- Reason: dsh-evolve hardcodes registration in the `settings.section` slot.
  - Moving it by editing third-party source is not viable: upgrades would overwrite the change, and the props contract is incompatible.
  - Writing a DSHOME-owned client plugin through the frontend build chain is a medium-to-large effort and not worth it currently.

## Future path
- Preferred form if ever implemented: conversation header button or trajectory tab.
- Option B is the correct route: a DSHOME-owned client plugin reusing `/api/evolve/*`.

## Changelog

- v1.1.0 (2026-08-31): refined with 1 new lesson memories
- v1.0.0 (2026-08-31): crystallized from 2 memories tagged "dsh-evolve" (LLM-distilled)

## Source memory ids

- mem_mtgs3vxa_755kgn (decision, imp2)
- mem_mtgsaz0k_6oyu3u (decision, imp2)

## Refinement v1.1.0 (2026-08-31)

> New evidence auto-appended by dsh-evolve. Fold into the prose above when convenient.

**Summary**
When DSH/Node code calls `tar` on Windows, it must resolve to `C:\Windows\System32\tar.exe` (bsdtar). Git for Windows GNU tar rejects Windows absolute paths like `C:\...`.

**Steps**
1. Before relying on `execFileSync('tar')`, verify which `tar` is first on `PATH`.
2. Keep `C:\Windows\System32` ahead of Git in `PATH`; the `开发启动.cmd` startup script already prepends it.
3. If PATH order cannot be guaranteed, explicitly call `C:\Windows\System32\tar.exe`.
4. Use bsdtar for any tar command that may receive a Windows absolute path such as `C:\...`.

**Pitfalls**
- Git for Windows GNU tar parses `C:\...` as `host:path` remote syntax, producing: `Cannot connect to C: resolve failed`.
- This was empirically confirmed on 2026-08-31.
- `execFileSync('tar')` hits the first `tar` on PATH; if Git's GNU tar is first, the command fails.
- `bsdtar` succeeded with the same command, so the root cause is tar variant/PATH order, not DSH/Node logic.

_source: mem_mtgsf62o_xk7mkd_

<!--dsh-evolve-state:{"tag":"dsh-evolve","version":"1.1.0","createdAt":"2026-08-31T05:17:27.985Z","baseDescription":"Use when handling dsh-evolve integration in DSHOME; covers v0.4.2 install, bsdtar backup, smoke checklist, and memory panel placement decisions.","sourceIds":["mem_mtgs3vxa_755kgn","mem_mtgsaz0k_6oyu3u","mem_mtgsf62o_xk7mkd"],"refinements":[{"version":"1.1.0","at":"2026-08-31T05:21:28.669Z","addedIds":["mem_mtgsf62o_xk7mkd"]}]}-->
