# Harness Scouter

[한국어](README.md) · [English](README.en.md) · [日本語](README.ja.md)

Turns the Claude Code transcripts sitting on your machine into 6 stats that measure **the quality of a coding agent harness**. It shows them as a character stat window rather than a report, and tells you how to raise the low ones.

What gets measured is the **harness**, not the model. The same model gives different results depending on how the prompts, context, hooks, and skills were put together, and this tool tries to measure that difference.

```
  HARNESS SCOUTER  all periods                                     Lv. 73  B

  Exploration         █████████████░░░░░░░░░░░  53  C   typical 46~58  best 67
      File-finding discipline 21   Content index first 44   Read before edit 92
  Verification        ████████████████████░░░░  82  A   typical 74~89  best 99
      Pre-commit verification freshness 85   No verification spin 80
  Completion          ██████████████████████░░  91  S   typical 87~94  best 99
  Autonomy            ██████████████████████░░  90  S   typical 84~97  best 100
  Discipline          ████████████████░░░░░░░░  67  B   typical 69~77  best 93
  Context efficiency  ██████████████████░░░░░░  73  B   typical 68~79  best 86

  Overall 73.2 · B  (4.8p to the nearest grade cutoff)
```

The useful part is not the number itself but **which component is the bottleneck**. In the screen above, Exploration 53 comes down to one thing, `File-finding discipline 21`, and fixing it takes Exploration from 53 to 72. That is how I used it while building this tool.

There is no external evidence yet that these scores correlate with actual quality. Read [Known limitations](#known-limitations) first to decide how far to trust them.

## Architecture

![Architecture](docs/architecture.en.svg)

Three tracks run separately.

**The behavior pipeline** pulls only facts out of the transcripts into SQLite, and recomputes the scores every time. The structure exists so that changing a definition does not mean reparsing 890MB. That is why there are no scores in `db.ts`.

**The harness structure scan** reads the inventory of sensors and guides out of the repository. Behavior alone cannot tell whether "0 blocks" means the sensors are good or that there are none. The axis names come from Martin Fowler's [harness engineering](https://martinfowler.com/articles/harness-engineering.html).

**The trust machinery** measures whether these numbers can be trusted. The reproducibility gate, the gaming scenarios, and the validity status live here.

## Data

Everything is local. Nothing leaves the machine. The one exception is `scouter outcomes`, the only command that asks GitHub for a list of PRs through `gh`.

```
~/.claude/projects/**/*.jsonl   read-only input. 890MB
~/.harness-scouter/scouter.sqlite   fact tables. 170MB
~/.harness-scouter/labels.jsonl     labels applied by a person
```

`--db` and `--labels` move those locations.

### Why SQLite, and how it is used

It uses the **built-in `node:sqlite`** from Node 22.5. A native module such as `better-sqlite3` gets caught in Electron ABI rebuilds inside the VSCode extension; the built-in module has none of that. That is why the only dependencies are dev tools.

The DB holds **parsed facts only**. No scores.

| Table           | What it holds                                                       | Rows (sample) |
| --------------- | ------------------------------------------------------------------- | ------------- |
| `session`       | Session metadata. Project, branch, model, entry point               | 424           |
| `tool_call`     | Tool calls. Name, command, file path, whether it was blocked, agent | 57,756        |
| `tool_result`   | Tool results. Lines read, edit kind, stdout tail                    | 57,748        |
| `usage`         | Tokens per response. Deduplicated per request                       | 46,241        |
| `session_event` | Interrupts, queued input, tool denials                              | 4,283         |
| `artifact`      | Commits, PRs, commit hashes                                         | 1,387         |
| `file_cursor`   | Per-file mtime and byte position                                    | 1,527         |

**Not storing the axis scores is the core of the design.** Metric definitions change often, and if every change meant reparsing 890MB, the iteration loop would fall apart. Facts are stored; axes are computed every time.

### It is safe to delete

The DB can be thrown away and rebuilt at any time. The transcripts are the original; the DB is derived.

```bash
rm ~/.harness-scouter/scouter.sqlite*
npm run scouter -- scan     # full 890MB reparse, 8s
```

The incremental scan remembers each file's mtime and byte position and reads only the lines appended since. With nothing changed it finishes in under 1 second.

**Labels are kept outside the DB.** Labels are the one input that cannot be pulled out of the transcripts again, and keeping them in the same container as derived data means losing them every time a definition changes. `labels.jsonl` is append-only, so a crash mid-write does not lose what came before, and a person can open and edit it directly.

## Install

Node 22.5 or later is required. Because it uses the built-in `node:sqlite` module, there are no native dependencies.

```bash
git clone <this repo>
cd harness-scouter
npm install
npm run build
```

The `gh` CLI is only needed to see PR outcomes (`scouter outcomes`). Everything else works without it.

## Usage

The first run is a scan. After that it is incremental and takes a few seconds.

```bash
npm run scouter -- scan
# 1,518 of 1,518 files updated / 310,802 entries parsed / 7.7s
```

### Seeing the stats

```bash
npm run scouter -- status --all   # all periods
npm run scouter -- status         # latest period only
```

`--all` merges every period and answers "how am I usually"; without it only the latest period is read, answering "how am I right now".

### Seeing how to raise them

```bash
npm run scouter -- guide --all
```

For each stat it points at the bottleneck component and gives what is counted, why it matters, the behavior that raises it, and **the antipatterns that raise the score without raising quality**.

### Seeing where it leaks

```bash
npm run scouter -- diag --all
```

It lists where large files were read whole, where commits landed without verification, and where files were touched through bash, each with the sessions as evidence. Exploration timeliness (main vs subagent) is here too.

### Seeing the harness structure

```bash
npm run scouter -- harness --root /path/to/repo
```

```
  96 sensors (88 automatic · 8 manual) · 58 guides
  Direction  feedforward 29  ·  feedback 67
  Execution  computational 87  ·  inferential 9
  Stage      pre-integration 3  ·  self-correcting loop 53  ·  post-integration 33  ·  continuous monitoring 7

  Guide/sensor sync   27 kinds of hook found across 323 rule documents
    4 gates that block without explanation: ...
```

### Seeing it as HTML

```bash
npm run scouter -- html --all --root /path/to/repo --out /tmp/scouter.html
```

A hexagonal radar, the stat bars, the grading table, the harness structure, the growth guide, and an early-half against recent-half comparison all fit on one page. It follows the viewer's light and dark themes.

### Everything else

```bash
npm run scouter -- gate         # M0.5 reproducibility gate
npm run scouter -- outcomes     # PR outcomes and signal discrimination (needs gh)
npm run scouter -- periods      # list of periods
npm run scouter -- json         # JSON for the extension
```

## How to read the screen

### Stats and components

| Stat               | What it asks                                             | Components                                                                               |
| ------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Exploration        | When it has to find something, does it use the right way | File-finding discipline · Content index first · Read before edit                         |
| Verification       | Does it check before it claims                           | Pre-commit verification freshness · No verification spin                                 |
| Completion         | Does it get all the way to an artifact                   | Artifact reached · No rework                                                             |
| Autonomy           | Does it finish without a person stepping in              | No human intervention                                                                    |
| Discipline         | Does it stay on the agreed rules and tool paths          | Instrumented channel use · No gate repeats                                               |
| Context efficiency | Does it read only as much as it needs and save tokens    | Read range discipline · Remembering what was read · Response brevity · Context lightness |

Each stat is the average of its components. Components with no denominator drop out.

### Bars and markers

```
Exploration   █████████████░░░░░░░░░░░  53  C   typical 46~58  best 67
```

- **The filled bar** is the current value, **typical** is p25~p75 of my own history, and **best** is my personal record.
- **The grade** is an absolute score for all periods, and a percentile against my own history per period.
- In HTML each component carries a `±` marker. It says how little that value moved across history, and larger is more trustworthy.

The target is the **personal best** because there is no basis for an absolute threshold. A value hit once is a target the data proves this harness can reach.

### Grading basis — can this be used on someone else's harness

Each component comes with the type of its target and how comparable it is.

| Target type            | Meaning                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `100 is the goal`      | Whatever is missing is a defect. Absolute comparison works                                |
| `higher is better`     | There is no basis for setting 100 as the goal. Only rank comparison means anything        |
| `beware both extremes` | Both ends can be bad, so this is not a maximization target. Left out of the overall score |

| Contamination flag             | Meaning                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `hook installs move the value` | Blocked calls drop out of the axis, so the more defenses you lay down the higher the score |
| `tied to tool names`           | On a harness with different tool names, that activity drops out of the count entirely      |
| `depends on task mix`          | It measures what got done that day, not the person                                         |

**If a component carries even one contamination flag, it is not used to compare people.** Right now `Read before edit` is the only one that carries none.

### Per-component definitions

What is counted (numerator and denominator), where the target comes from, and what breaks comparison. `scouter guide` gives the same content in bottleneck order.

| Stat               | Component                         | What is counted                                                                                                                                                                             | Target                   | Contamination              |
| ------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------- |
| Exploration        | File-finding discipline           | Share of file-path lookups that went through the `Glob` tool. `find … -name` is the rest of the denominator                                                                                 | 100 is the goal          | hook installs · tool names |
| Exploration        | Content index first               | Share of content and relationship lookups that went through qmd or graphify. Counts both MCP and CLI; read and diagnostic calls (`qmd get`, `graphify stats`) are not searches and come out | higher is better         | hook installs · tool names |
| Exploration        | Read before edit                  | Share of edits to existing code files where the file was read first. A newly created file has nothing to read and comes out of the denominator                                              | **100 is the goal**      | tool names                 |
| Verification       | Pre-commit verification freshness | Share of code-touching commits where verification ran **after** the last edit                                                                                                               | higher is better         | task mix · tool names      |
| Verification       | No verification spin              | Inverse of verifier calls that re-ran the same kind with no edit in between                                                                                                                 | higher is better         | task mix                   |
| Completion         | Artifact reached                  | Share of code-touching sessions that got as far as a commit or a PR                                                                                                                         | higher is better         | task mix                   |
| Completion         | No rework                         | Inverse of editing the same file again after skipping verification or a commit                                                                                                              | higher is better         | tool names                 |
| Autonomy           | No human intervention             | Interventions per 100 assistant turns. Interrupts, queued input mid-run, and tool denials counted together                                                                                  | **beware both extremes** | task mix                   |
| Discipline         | Instrumented channel use          | Share of edits and bash file access that went through instrumented tools. `cat`, `awk`, interpreter reads and `sed -i`, heredoc writes are the numerator                                    | higher is better         | tool names                 |
| Discipline         | No gate repeats                   | Share of blocked calls where the same agent did not hit a gate it had already hit. With no blocks there is no denominator and no verdict                                                    | higher is better         | hook installs              |
| Context efficiency | Read range discipline             | Share of reads of files over 200 lines that specified a range. A range covering the whole file does not count                                                                               | higher is better         | tool names                 |
| Context efficiency | Remembering what was read         | Share of reads that did not read the same file again. Re-checking after an edit is legitimate and comes out                                                                                 | higher is better         | tool names                 |
| Context efficiency | Response brevity                  | Output tokens generated per read or edit call. 1,000 tokens is full marks, 4,500 tokens is 0                                                                                                | higher is better         | tool names · task mix      |
| Context efficiency | Context lightness                 | Cached context carried along on every request. 100K is full marks, 400K is 0                                                                                                                | higher is better         | tool names                 |

**What comes out of the denominator is half the definition.** `find -type d` and counting, which `Glob` cannot stand in for; a new file with nothing to read; the legitimate re-check after an edit — leave those in the denominator and the score drops every time there is no alternative, which closes off the honest path.

Only two components are `100 is the goal`. For the rest there is no basis for setting 100 as the target, and forcing a ceiling would make bad behavior pay off instead (padding the artifact rate with empty commits, reading files whole to remove revisits).

## What the design holds to

**Facts are kept apart from interpretation.** The DB holds parse results only, and the axes are recomputed every time, because definitions change often.

**Decision boundaries are pinned in code.** When they lived in prose alone, recomputing the same axis gave a different value each time. Now `definitions.ts` and `bash.ts` are the single reference, and the documents point at the code.

**Gaming resistance is applied to the metrics themselves.** Each axis registers the paths where "activity stays the same but the arithmetic gets better", and measures how far the score rises along them. It is the same shape as mutation testing for tests. Each scenario records what stays physically unchanged (the invariant) and which condition in which function gets through (the mechanism).

**Blocked calls come out of the axes.** Leave them in and you get the paradox that the better the gates work, the worse the score.

**Limitations are not hidden.** The footnotes on screen say there is no external evidence, and what was tried and rejected.

## Known limitations

**This is a diagnostic tool, not a report card.** Start with what it can and cannot be used for.

| What it can do                                                              | Example                                              |
| --------------------------------------------------------------------------- | ---------------------------------------------------- |
| Find where my bottleneck is                                                 | `File-finding discipline 21` → move `find` to `Glob` |
| Compare stretches of time under the same definition                         | Early half against recent half                       |
| See which sensors the harness has and where they diverge from the documents | 4 gates that block without explanation               |

| What it cannot do                      | Why                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| "We are above the team average"        | Grades are relative to my own history, so there is no comparing with anyone else            |
| "Better than the previous period"      | Correlation between neighboring periods is 0, so noise and improvement cannot be told apart |
| "This score means the quality is good" | There is no external evidence linking score to quality                                      |

Here is why.

### 1. No external ground truth — a scale with no calibration weights

This tool reports "Exploration 53". But **there is no way to check whether 53 is good or bad**, because there is no answer key to say which session actually did better work, the one at 53 or the one at 80. So grades are set against my own history. It answers "better than usual" and cannot answer "is this good".

Two attempts at an answer key, two rejections. Both are recorded with their numbers in `validity.ts`.

| Attempt      | Method                                                               | Why it was rejected                                                                                            |
| ------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Human labels | Mark each session good or bad, 30 collected                          | Needs a person per session so it does not scale, and evaluating someone else's harness would need their labels |
| PR outcomes  | Use the merge and review records already in GitHub as the answer key | The signal does not discriminate, and it came out opposite to the prior hypotheses                             |

Why PR outcomes do not work comes apart into two tables.

```
Signal discrimination (509 PRs in the repo)
  Merged             453/509 merged (89%)   a test almost everyone passes cannot rank anyone
  Changes requested  2/509                  not a signal at all
  Review rounds      median 2               usable
```

```
Prior hypotheses against measurement (written down before looking at the data)
  Higher verification → fewer review rounds   measured +0.201   opposite
  Higher exploration  → fewer comments        measured +0.134   opposite
  The remaining 1                                               direction held

  Largest correlation   Autonomy × comment count 0.286
                        ← the axis declared in advance to have no causal path
```

When the axis nailed down as unrelated ranks 1st, that is not a finding, that is noise.

### 2. Reproducibility gate 2/6 — scoring the odd and even halves

A period holds about 14 sessions. They are split at random into two groups of 7 and scored separately. **It is the same period, so the two scores should come out close** (the way scoring a test's odd questions and even questions separately still shows the same ability).

On 4 of the 6 axes they are not close. That means the period score reflects **"which sessions happened to land in this period"** rather than "I did well in this stretch".

| Screen      | Axes that hold up | Why                                                                      |
| ----------- | ----------------- | ------------------------------------------------------------------------ |
| All periods | 2/6               | Every period is merged, so reproducibility within a period is not needed |
| Per period  | 2/6               | Scores have to reproduce inside a period, and 4 axes fall short          |

Growing the period 2x, 3x, and 4x did not help. The cause looks less like "too few samples" and more like **the work differing too much from session to session**. It amounts to putting a refactoring session, a bug-fix session, and a documentation session in one bucket and taking the average.

### 3. Predictive power across periods is 0 — not skill, just the day's form

For something to be called "skill", a good period should tend to be followed by another good one. Measuring the correlation between neighboring periods (lag-1), 5 of the 6 axes sit near 0. Based on 29 closed periods.

| Axis                        |        1x |     2x |     3x |     4x |
| --------------------------- | --------: | -----: | -----: | -----: |
| Read range discipline       |    -0.046 | -0.339 | -0.434 | -0.793 |
| Read round-trip restraint   |     0.159 | -0.265 | -0.180 | -0.529 |
| Verification freshness      |     0.078 | -0.156 | -0.226 | -0.282 |
| Verification spin restraint |    -0.159 | -0.321 | -0.199 |  0.191 |
| Instrumented channel use    | **0.621** |  0.049 | -0.127 | -0.127 |
| Index-first search          |    -0.082 |  0.147 | -0.211 | -0.368 |

**If this were a sample-size problem, merging periods should push the numbers up, but they go the other way.** Read range discipline reaches -0.793 when merged 4x. That means neighboring periods do not predict each other at any aggregation size, so it is not an item that can be fixed into passing.

Instrumented channel use is the one high value, 0.621 at 1x, and **it collapses to 0.049 the moment periods are merged 2x**. If skill carried over, it would survive merging. This looks like the regularity of a batch of similar work done back to back, picked up as correlation.

So **there is no "up 3 points from the previous period" display.** Those 3 points cannot be told apart from noise. Comparison happens only in large blocks, such as the early half against the recent half.

### 4. Tied to the Claude Code schema

The metrics are **defined by tool name**: "did it use `Glob`", "did it read with `Read`". Carry them as they are to a harness with different tool names and the score comes out 0, not because that harness is bad but because **this tool does not recognize it**.

This repository fell into the same trap once. Counting graphify by its MCP tool name only, **1,220 CLI calls were seen as 4**. 1/300 of actual use.

## Development

```bash
npm run build       # tsc --build
npm test            # vitest run
npm run typecheck
```

152 tests. When you change a definition, change the regression tests with it — the values move, and static checks will not catch that.

```
packages/core   parser · extract · fact tables · metrics · periods · stats · gate · views
packages/cli    scouter commands
packages/ext    VSCode extension (status bar · panel)
```
