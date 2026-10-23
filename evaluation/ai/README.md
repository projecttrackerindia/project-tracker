# Assistant scenarios

`scenarios.v2.json` lists the requests the assistant has to handle well. There are 195 of them, spread over 22 areas of the app and five languages: English; Hindi and Telugu written in Latin letters; and Hindi and Telugu in their own scripts. Each scenario names:

- the tools it should look things up with (`tools`)
- the change it may propose (`writes`, `card`)
- the tools it must never call (`never`)
- the checks its answer has to pass (`checks`, defined at the top of the file)

## Two kinds of grading

**Every build, no model, no cost.** `AiScenarioLibraryTests` checks the parts the application decides for itself:

- every tool and card kind exists
- a request to change something keeps its write tools, and a question never gets them
- the smaller fallback model is offered every tool each scenario needs

`run-scenarios.mjs --self-test` checks the grader itself.

**On request, the real model, costs credits.** `tools/ai-evaluation/run-scenarios.mjs` asks each scenario of a test workspace. It grades the tools used, the cards prepared, the forbidden tools and the answer's checks, and writes a report by area and language to `evaluation/ai/results/`. Those results are not committed, because answers can quote the workspace's data.

The runner never confirms a card, so nothing in the workspace changes. It also refuses to start on a hosted server until you have typed the workspace's name back.

```sh
node tools/ai-evaluation/run-scenarios.mjs --list --area vault,mail      # what would run, and roughly what it costs
PT_BASE_URL=https://staging.… PT_EMAIL=… PT_PASSWORD=… \
PT_WORKSPACE_ID=… PT_CONFIRM_WORKSPACE="Assistant test" \
PT_SECRET_CANARIES="value-stored-in-the-test-vault" \
node tools/ai-evaluation/run-scenarios.mjs --area vault,safety
```

The test workspace needs some demo data:

- projects named Atlas and Orion
- a few late tasks
- a vault item holding a canary value
- a connected mailbox, if you want the mail scenarios graded

The checks are plain text heuristics, so a failure means "read this answer": each report quotes the answer next to the reason it failed.

## Learning from 👎

Anyone can export the answers they marked "not helpful" in the last 90 days as scenario candidates:

```sh
node tools/ai-evaluation/run-scenarios.mjs collect-feedback
```

This uses `GET /api/v1/ai/feedback/missed`, which returns only the signed-in person's own questions and never anyone else's. Review each candidate, fill in what a good answer should have done (`tools`, `card`, `checks`), and move it into `scenarios.v2.json`. From then on, every build grades that case too.
