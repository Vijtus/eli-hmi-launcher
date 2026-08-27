# Field reports

Evidence from runs on `TESTZ-OPR04` itself. The launcher writes these on the way
out of every session: what it found, what it launched, and what happened ten
seconds later.

These are summaries. The full reports also carry a survey of the machine's
filesystem, which is how the missing-panel question was answered — that part is
left on the machine rather than archived here.

| File | What it shows |
|---|---|
| [`2026-08-27-panels-missing.md`](2026-08-27-panels-missing.md) | 13/15. Power Meters and Centroids fail: `Phoebus starts, but the panel does not exist`. The survey behind this run found 272 panels under `css-gui\panel\` and no `panel\TESTZ`, which is what proved the files were absent rather than misplaced. |
| [`2026-08-27-all-15-working.md`](2026-08-27-all-15-working.md) | 15/15 after the panels were copied into `panel\TESTZ\`. `## What is not working` reads *"Nothing"*. Both Phoebus entries launch with the corrected `panel/TESTZ/…` resource and no missing-file error. |
| [`2026-08-27-gitlab-reachable.txt`](2026-08-27-gitlab-reachable.txt) | The workstation resolves and reaches `gitlab.eli-beams.eu`, and clones `lcs/eli-hmi-config` successfully — despite having no internet access. This is what makes git-backed configuration possible on that machine. |

## Reading the launch results

`RUNNING` means the process was still alive ten seconds after launch. It is not
proof the *right* program opened — several entries can resolve to real but
different executables — so it is worth comparing against what appeared on screen.

`STARTED` is normal for Phoebus entries. Phoebus runs as a server: the second and
later launches hand a resource to the already-running instance and exit
immediately, so the launched process is gone long before ten seconds.

## A note on the GitLab check

Step 4 of the reachability check reports `403 Forbidden` on the REST API while
step 6 clones successfully. That is not a broken token. The token carries
`read_repository` scope but not `api` scope — correct scoping for this purpose.
The API probe was simply the wrong test for that kind of token.
