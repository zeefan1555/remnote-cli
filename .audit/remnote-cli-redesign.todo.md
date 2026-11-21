# Multi-phase plan todo

- [x] 1. When the change is one or two files with an obvious approach, skip the plan. Say so and stop.
  result: the change spans schemas, transport, execution, tests and docs.
- [ ] 2. Settle open questions by prototype before you write, per `playbooks/prototype.md`. Ask the operator only about a product or preference call that no run can settle.
  skip: this is plan-only. Performance and recovery claims are explicit gates in CLI-3 and CLI-4.
- [x] 3. Write the plan file. Open with what changes, the PR ids in landing order, and the dependency graph, which says which PRs are independent and branch from trunk, which wait for which, and the files each may touch. Then one section per PR. One PR is one change with its own evidence (the **sequence-verifiable-units** principle skill). Each section has checkboxes for what it depends on, the files it edits, the one change it builds, the result you see, and its verification.
  result: docs/plans/2026-11-22-remnote-cli-optimization.md
- [x] 4. Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Each live box drives the real surface through the driver skill, in its own worktree, with a concrete scenario and a pass predicate. The perf box names the metric, the probe, the trunk baseline measured first, and the number that fails. A PR that changes an interaction waits for the operator's review before merge.
  result: every PR contains unit, live and perf checkboxes. BRIDGE-0, CLI-0, CLI-2, CLI-4 and CLI-5 are review-gated.
- [x] 5. Hand back the plan path and stop. Execution starts on the operator's explicit go.
  result: planning finished without code changes.

