---
description: Validate a DCAM screen in a real browser against the UV checklist (spec §19.6)
argument-hint: <screen ID or route, for example S-05 or />
---

Validate $ARGUMENTS with the ui-validator subagent.

1. Make sure the UI is built and DCAM runs in demo mode: `pnpm dcam --demo --no-open` (background).
2. Hand the ui-validator the screen ID, the route and the feature folder (if any).
3. Report failed checklist items first, with evidence and the smallest fix. Do not fix product code
   inside the validation; fixes are a separate /tdd step.
