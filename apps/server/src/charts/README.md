# Four measured charts

The same `RunCharts` component serves FIFO and payments pack rows. Only these
charts render: new verified breaches, cumulative found versus fixed with the
open gap, held-out pass rate, and generations to fix each retained exploit.
The software view retains its evidence table and candidate inspector.

The source is `data/runs/<run-id>/timeseries.jsonl`. One current row is stored for
each `(run, pack, arm, seed, generation)`:

```ts
{ run, pack, arm, seed, generation, t_elapsed_s,
  breaches_new, breaches_cumulative, fixed_cumulative, open_bugs,
  heldout_pass, heldout_total, fix_generations }
```

Every row comes from actual verifier results. Breaches require replay. Fixes
require a passing retained regression, not a model's claim. Re-audits of unchanged
source update the existing generation rather than inventing another generation.
`fixed_cumulative` is the count of currently closed retained exploit instances;
it can fall if a regression reopens. `open_bugs = breaches_cumulative -
fixed_cumulative`. Counts are witness instances, not a claim to distinct semantic
bug classes. `fix_generations` lists measured closure delays in discovery order
within each seed, omitting still-open exploits. No trend is forced downward.

`GET /api/charts/<run-id>/events` streams full `timeseries` snapshots through SSE.
The client replaces its snapshot, so reconnects cannot duplicate points. Tooltips
show counts. The accuracy plot aggregates executed checks at the same generation
within each memory arm. Found/fixed state carries forward the last observed state
of a seed that stopped earlier; it creates no extra trial or hidden verdict.
Unknown software memory modes are labeled `Recorded run`, never `Lesson graph`.
With no observations, each chart says `no run yet`.

```sh
pnpm charts <run-id>
# For an older controller that predates the write hook:
pnpm charts <run-id> --watch
```

The exporter writes exactly four PNG files and four SVG files to
`data/runs/<run-id>/charts/`. `manifest.json` records data, renderer and artifact
hashes. A read-only recorder can reconstruct old full hardware exports or intact
journals without calling the mutating store recovery loader. Old ablation reports
use the actual report file's modification time when a verdict timestamp was not
yet recorded. Current reports save the verdict timestamp directly.

Each row is mirrored into an Arize generation-metrics experiment. The local
`timeseries-arize.json` receipt records acknowledged rows and errors. A revised
row is retained as a new revision remotely and replaces its current local row.
Raw JSONL remains available if the external export fails. Export receipts require
remote metric readback, not just an HTTP success response.
