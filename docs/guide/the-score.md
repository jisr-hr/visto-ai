---
title: The score
description: The score measures how much a change needs a person's judgement.
---

The score measures how much a change needs a person's judgement. It does not measure how likely the change is to contain a bug: findings cover bugs.

| Score | Meaning | Examples |
|---|---|---|
| 0% to 19% | No judgement involved | Generated files, formatting, documentation text |
| 20% to 39% | Mechanical | A rename, new tests that mirror existing behaviour |
| 40% to 69% | A local behaviour change that follows an existing pattern | A bug fix inside one function |
| 70% to 89% | A decision | A changed business rule, data model, public contract or permission check. A new dependency. A weakened test |
| 90% to 100% | A decision that is costly to get wrong | Authentication, tenant isolation, an irreversible data migration, billing |

The scored unit is a block: one hunk of the diff. A file with ten changes, of which one is a decision, sends a person to that one change and not to the whole file.
