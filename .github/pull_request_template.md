<!--
Closing keywords are how an issue closes itself. GitHub closes an issue when a
merged PR's *description* says `Closes #n` / `Fixes #n` / `Resolves #n` — a
bare `#n` only links, which is how #41 stayed open through the PR that fixed
it. Squash merges honour this the same way.

Reference a pull request as `PR #n`, never a bare `#n`: CodeRabbit's
out-of-scope check reads a bare number as a linked *issue* and then correctly
reports that this PR does not implement it. That warning on #48 was caused by
the description, not the code.

Delete whichever lines below do not apply — an empty heading is worse than no
heading.
-->

Closes #

## What changed

## Why

<!-- What breaks if this is wrong, and what you measured rather than assumed. -->
