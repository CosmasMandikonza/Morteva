# PR review and risk-weighted merge protocol

**Default:** review the actual diff, not the PR summary. Merge proactively when the relevant evidence passes; do not require the founder to reapprove routine changes. Pause for external secrets, payments beyond sandbox/testnet, license purchases, approved brand selection and unresolved safety risk. This policy supersedes any earlier blanket "never merge" instruction.

## Review checklist: exactly one complete review, avoid endless prompting
1. **Refresh repository truth:** list all open PRs, read base SHA and exact head SHA, changed filenames, full diff, prior review threads, issue dependency, CI/check statuses and any overlapping PRs. Confirm intended target branch.
2. **Verify contract:** trace the user-visible path, each edited state machine/finance function, API/authorization boundary, and relationship to the assigned issue. Check data leaks, design asset licensing, unrelated edits, and whether tests actually assert behavior.
3. **Run or inspect real evidence:** execute available tests when environment permits; otherwise inspect CI run and report that local execution was not possible. Never claim CI is green if no workflow exists. Review real captured UI images at required states and sizes, not screenshot filenames alone.
4. **Probe negative scenarios:** raise must-fix issues for money correctness/security, provider idempotency, stale approvals, tenant isolation, invalid input, broken primary UX. Distinguish P0 block from deferred polish with direct evidence.
5. **Make one coherent decision:** (a) fix on branch and re-review exact new head, (b) request changes with smallest reproducible blocker, or (c) merge using `expected_head_sha` after all required gates. No superficial APPROVED review. A self-reviewed PR is not an independent second-party approval.
6. **After merge:** verify PR merged, main SHA, relevant file presence and link to issue; update `docs/STATE.md` with evidence, close issues only if acceptance is met, identify next unblocked ticket. No merge while review changes are pending or mergeability unknown.

## Risk tiers (match highest risk changed file, not declared title)

| Tier | Examples | Necessary gates before merge |
|---|---|---|
| **R0 Docs** | Docs, templates, non-executable diagrams | Manual diff review; factual/sponsor/API claims checked; internal links resolved; no secrets; verify current head/target. CI not required if no workflow exists; state that honestly. |
| **R1 UI and 3D** | Layout, asset, renderer, test UI | Screenshot comparison to approved references; keyboard/touch/reduced motion; license; no mock data misrepresented; tested responsive camera/fallback. CI when available. |
| **R2 Domain/backend** | DB schema, planner, event engine, auth routes | Actual unit+integration tests, typecheck, adverse-path tests, migration/restart and tenant authorization checks, regression; no undocumented economic claim. |
| **R3 Money/provider/security** | Credentials, payment creation, approvals, idempotency, webhook, reservation | All R2 gates PLUS replay/race tests, error/timeout handling, provider status proof in appropriate sandbox/testnet, secret scan, independent readback and explicit review of limits/fees/amount units. If sandbox inaccessible, only merge a correctly disabled and clearly labeled integration seam without claiming live readiness. |

**No compromise:** missing R3 evidence blocks a claim of complete payment functionality. R0 docs may merge without fictitious code tests.

## Must-block patterns
- Secret or access token exposed in diff/logs/UI; unreviewed dependency executing code.
- No server-side authorization for a sensitive operation, cross-tenant leak, mutable approvals, revoked mandate still usable.
- Wrong money units, reserve race, blind retry on unknown transfer, duplicate economic intents, provider "submitted" presented as settled.
- Unlicensed or misleading asset; brand approved without reference decision; visibly obstructed controls or unusable financial alternative path.
- Tests merely mock all core flows while PR claims live provider execution.
- Unknown/changed PR head SHA, unresolved reviewer blockers, incompatible base, or unexpected high-risk scope.

## Review output template
```md
Verdict: MERGE | FIX THEN RECHECK | BLOCK
PR: # / title
Exact base -> head:
Files and intended effect:
Verified evidence (commands, CI URL, redacted receipts, visual captures):
Critical risk / failing reproduction:
What remains untested:
Corrections made:
Merge SHA (only if merged):
Next issue:
```

## Efficiency and quality rules
- One reviewer response should aggregate all critical findings, prioritized P0/P1/P2, with concrete expected test or screenshot.
- Fix P0/P1 in the same scoped branch unless a clearly independent follow-up issue is safe; avoid dozens of vague review cycles.
- Do not ask the founder to approve every engineering detail; ask only for decisions explicitly reserved in product/design docs.
- Avoid merging unrelated code into a 'foundation' PR. Branch from up-to-date main after documentation foundation lands.
- No automated merge if a required check is red, unknown for critical tier, or missing required provider proof.

## Source
Internal protocol informed by actual failure modes and user instruction to review and merge efficiently, not an external security certification.
