# Antibody: web

A clean, neutral dashboard for the arena. It has three views:

1. **Overview**: headline stats, the worlds matrix (attack types down the left, generations across,
   one dot per forked world), and an activity feed. Select a world to see its details in the side panel.
2. **Metrics**: survival rate, dollars lost, false alarms, and parallel vs sequential time, with a
   table view.
3. **Graduation**: the three steps (final exam, human approval, production), the exam results, the
   approval call and the production commit.

Vite + React 19 + TypeScript. There's no UI kit and no chart library: the charts and the matrix are
inline SVG. Icons come from `lucide-react`. Fira Sans and Fira Code are self-hosted through
Fontsource. The app has light and dark themes: it follows the OS setting, and the header has a toggle.

## Run it

```bash
cd web
npm install
npm run dev          # http://localhost:5173
```

- **Standalone:** opens on the bundled sample (`public/sample-run.jsonl`) and replays it.
  No backend needed.
- **Live:** start the arena (`make arena`, FastAPI on `:8000`), pick **Live arena** in the source
  menu, then press **Start run**. Vite proxies `/api/*` to `http://localhost:8000`; override that with
  `ARENA_URL=http://127.0.0.1:8000 npm run dev`.
- **Recorded runs:** the source menu lists `GET /api/runs` when you open it.

| Script | What it does |
| --- | --- |
| `npm run dev` | dev server on :5173 with the `/api` proxy |
| `npm run build` | `tsc -b && vite build` (must pass with 0 errors) |
| `npm run typecheck` | `tsc -b` only |
| `npm run preview` | serve `dist/` on :4173 (same `/api` proxy) |

URL parameters keep the presenter's choices across reloads:
`?source=sample|live|run:<run_id>&speed=1|4|16|instant&tab=arena|scoreboard|graduation`

Keys: `1`–`3` switch views, `Space` play/pause, `R` restart, `N` next event, `Esc` closes world details.

## Design rules

These come from the design skills: ui-ux-pro-max, dataviz, better-ui and animate.

- **Status:** defended is green, breached is red, a false alarm is amber, a clean control is gray, and
  a pending world is a dashed ring. Every status also has a glyph and a text label, so color is never
  the only cue. The status colors are the dataviz status palette, checked for contrast in both themes.
- **Color:** neutral slate surfaces with one blue accent. Text tokens clear 4.5:1 in both themes.
  Text never takes a data color; only marks do.
- **Charts:** one series color, 2px lines, 8px markers with a surface ring, bars no wider than 24px
  with a 4px rounded end, and solid hairline gridlines. A table view backs every chart.
- **Motion:** almost none. A new world fades in, a pending world pulses, and statuses change color.
  Transitions are switched off during a theme change, and `prefers-reduced-motion` is respected.
- **Fake data:** when the latest `gen.started` says `backend: "fake"`, a notice and a "Fake data"
  badge say so. Numbers on stage must come from a real run.

## How it works

```
ArenaEvent stream ──► reduce(state, event) ──► ArenaState ──► views
 (live SSE, a recorded run, or the sample)       (state.ts)    (render from state only)
```

- `src/contracts.ts` mirrors `contracts/models.py` by hand. **Don't edit it here alone**: the
  Python models are the source of truth.
- `src/state.ts` is the only place events become UI state. `reduce` is pure, so live and replay
  render identically. The selectors at the bottom (`genStats`, `orderedGenerations`, …) feed the views.
- `src/useEventSource.ts` (`useArenaFeed`) feeds events in from the live SSE stream (it reconnects on its
  own) or replays a recording with its original timing divided by the speed.
- `src/views/arenaLayout.ts` turns state into matrix geometry: rows, columns, dot positions, lineage
  curves. It's pure and deterministic, and every size constant lives at its top.
- A `gen.done` with `mode: "sequential"` is an A8 timing run. It only feeds the parallel-worlds card.

## File map

```
web/src/
  main.tsx               React root and font imports
  App.tsx                shell: header, notices, view switch, theme, keyboard shortcuts
  styles.css             design tokens (light and dark) and every style
  contracts.ts           event and payload types (mirror of contracts/models.py)
  state.ts               ArenaState, the pure reducer, selectors
  useEventSource.ts      live / recorded / sample feed and the replay engine
  api.ts, format.ts      fetch helpers, formatting
  components/
    TopBar.tsx           name, view tabs (TABS), replay controls, source picker, theme toggle
    Glyph.tsx            status glyphs, labels and dots
    Activity.tsx         the activity feed, derived from state
    WorldDetails.tsx     one world: verdict, attack, defender plan, sandbox link
  views/
    Overview.tsx         stats row, worlds matrix, legend, side panel
    arenaLayout.ts       matrix geometry (pure; sizes at the top)
    Metrics.tsx          stat tiles, survival line, dollars bars, false alarms, speedup, table
    Graduation.tsx       steps, exam results, approval call, production commit
```

## Add a view

1. Create `src/views/MyView.tsx` that takes `{ state: ArenaState }` and renders from it only.
2. If you need derived numbers, add a selector at the bottom of `src/state.ts`. Don't keep copies
   of state in the view.
3. Add it to `TABS` in `src/components/TopBar.tsx` and to the view switch in `src/App.tsx`. It gets
   the next number key automatically.
4. If it needs new backend data, add that to the contract first (`contracts/models.py` and
   `src/contracts.ts` together), then handle the event in `reduce`.

## Sample data

`public/sample-run.jsonl` is a real recording from the **fake** backend
(`python -m scripts.replay runs/<run>.jsonl --to-web`). It has 4 generations of 6 attack worlds plus
2 clean worlds, the lessons, an exam on 5 held-out attacks, the approver call and the prod commit.
Replace it with a Daytona recording once one exists.
