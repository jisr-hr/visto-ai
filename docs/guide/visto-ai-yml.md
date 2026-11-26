---
title: ".visto-ai.yml"
description: A team may commit `.visto-ai.yml` at the root of its repository, listing paths that always need a human reviewer.
---

A team may commit `.visto-ai.yml` at the root of its repository, listing paths that always need a human reviewer. It is read from the default branch and can only add protection.

```yaml
# .visto-ai.yml
human_review:
  - db/migrate/
  - "app/**/policy.rb"
```

- A trailing slash is ignored, and a pattern with no slash left matches at any depth: `migrations/` is the same as `migrations`, and covers `migrations/x.sql` and `services/api/migrations/x.sql`.
- A pattern with a slash anywhere but at its end is matched from the repository root. `db/migrate/` therefore covers `db/migrate/001.rb` and never `services/db/migrate/001.rb`.
- A leading slash also ties a pattern to the root: `/docs` matches only the top-level `docs`, while `docs` matches at any depth.
- A pattern that names a directory covers everything under it, dot-files included.
- The wildcards are `*` (any run of characters within one name), `?` (one character) and `**` (any number of directories): `app/**/policy.rb` covers `app/policy.rb` and `app/models/user/policy.rb`.
- `**` is special only as a whole path segment; inside a name, such as `a**b`, it is two `*`.
- Matching is case-sensitive.
- A renamed file is checked by its old path as well as its new one.
- Brackets are ordinary characters: `app/[id]/page.tsx` matches only that path.
- A pattern with a backslash, a brace, a `.` or `..` segment, or a leading `!` is refused, and makes the file unusable.

A file that cannot be used (invalid YAML, an unknown key, a refused pattern, content that is not text, or one that is too large) sends every pull request to a person, and the review says why the file cannot be used.
