---
title: Inline notes
description: An inline note is a short comment in the diff, on a block that a person should read.
---

An inline note is a short comment in the diff, on a block that a person should read. It is off. **It was tried once against a real GitHub App**, on a small private repository, with few notes in each review.

Switch it on with `score.inlineNotes: true`, under `repositories.defaults` for every repository or under `repositories.overrides` for one (see [config.example.yml](../../config.example.yml); when a scorer is named, `repositories.defaults.score` must write `threshold` too). What a note does:

- **One note for each block** at or above the score threshold, on the block's first line, on the old side when the block's label says `old`. It says most of what the body's line for the block says: the lines, the score, the category and the first line of the reason. A block scored on another pull request shows its category and never its reason. Of two blocks with the same lines, the one that scored higher gets the note.
- **At most 50 a review**, the highest scores first, and in path order among equal scores. The blocks left over get their note at a later review that still lists them.
- **Once for each block.** A block (same file, same changed lines) that already has a note on the pull request gets no second one. A note GitHub gives back is recognised by the part of its text the service wrote (the lines, the score and the category), not by the model's reason. This is known from the notes the service has stored, and from the threads it reads before a later review; in dry run none of it is read, so each head records its notes as if none had been given.
- **A note is a review thread.** Where a repository requires resolved conversations, someone has to resolve each note before a merge. The app never resolves one. A note is not a finding: no later review judges it, shows it to the model, replies into it or counts it as a finding already discussed.
- **When GitHub refuses a review for a comment,** the service posts it again with the findings' comments and without the notes. If it refuses again, the review is posted with the body written whole and no comment; a review with no findings ends `publish_rejected`. The notes are then not posted, and the next review of the pull request tries them again. A note, or a finding's comment, that GitHub never accepts therefore keeps every note of that pull request from being posted, with one refused try at each review. The sign is `notes_dropped` true in the `review` log line at every review of that pull request; it is also true once for a review a later start publishes, and for a review the service finds already posted that holds none of its notes.
- **Counts in the log.** `notes` is how many notes the review carried. In the `readback` line, `notes_missing` above 0 means that a note the review posted was not found, by its lines, its score and its category, among the comments GitHub gives back: such a note is not recognised as posted, and would be posted again. When notes cannot be rendered at all, the log says `notes_failed` and the review goes without them.

What it costs:

- A flagged block that is edited, a block whose hunk merged with its neighbour or was split, and every flagged block of a renamed file are new blocks: each gets a new note, and the old notes' threads stay for someone to resolve.
- A block flagged only through its file's whole-file score gets no note, so a model that answers files as a whole gives few notes.
- With more than 50 flagged blocks, the body lists 50 entries, file by file, and the notes take the 50 highest scores, so a block can be in neither the list nor the notes of one review.
- A review that a later start publishes (its first publication failed, or the service stopped before it was posted) goes without its notes. They come with the next review.
- Each note is a thread, so the limits on reading a pull request's threads (20 pages of 100) and of a review's comments (20 pages of 100) are reached sooner. At the comment limit a review's comments are not stored by the read-back; they are stored from the threads at a later review, when those can be read. A pull request whose threads cannot be read gets no later review (see [Running it](running-the-service.md)).
