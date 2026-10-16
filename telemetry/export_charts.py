"""Export exactly four charts from measured generation rows, without invented data."""
import json
from pathlib import Path
import sys

LABELS = {"none": "Claude alone", "flat": "Raw retrieval", "graph": "Lesson graph", "recorded": "Recorded run"}
COLORS = {"none": "#5c95f5", "flat": "#e5a84b", "graph": "#aa81f2", "recorded": "#77c4bd"}


def aggregate(rows):
    output = {}
    for arm in sorted({r["arm"] for r in rows}):
        group = [r for r in rows if r["arm"] == arm]
        points = []
        for generation in sorted({r["generation"] for r in group}):
            exact = [r for r in group if r["generation"] == generation]
            latest = []
            for seed in sorted({r["seed"] for r in group}):
                available = [r for r in group if r["seed"] == seed and r["generation"] <= generation]
                if available:
                    latest.append(max(available, key=lambda r: r["generation"]))
            points.append({"generation": generation, "new": sum(r["breaches_new"] for r in exact), "found": sum(r["breaches_cumulative"] for r in latest), "fixed": sum(r["fixed_cumulative"] for r in latest), "pass": sum(r["heldout_pass"] for r in exact), "total": sum(r["heldout_total"] for r in exact)})
        output[arm] = points
    return output


def export(path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.ticker import MaxNLocator
    source = Path(path)
    rows = [json.loads(line) for line in source.read_text().splitlines() if line.strip()]
    for r in rows:
        assert r["heldout_pass"] <= r["heldout_total"]
        assert r["fixed_cumulative"] + r["open_bugs"] == r["breaches_cumulative"]
    directory = source.parent / "charts"
    directory.mkdir(exist_ok=True)
    plt.rcParams.update({"font.size": 11, "svg.fonttype": "none"})
    groups = aggregate(rows)
    titles = [("01-breach-curve", "New verified breaches", "Generation", "Reproduced breach instances"), ("02-found-vs-fixed", "Found versus fixed", "Generation", "Verified exploit instances"), ("03-heldout-accuracy", "Held-out accuracy", "Generation", "Passed / executed held-out checks (%)"), ("04-time-to-fix", "Time to fix", "Fixed exploit, in discovery order", "Repair generations")]
    paths = []
    for index, (stem, title, xlabel, ylabel) in enumerate(titles):
        fig, ax = plt.subplots(figsize=(10, 5.2), constrained_layout=True)
        plotted = False
        for arm, points in groups.items():
            label = LABELS.get(arm, arm)
            color = COLORS.get(arm, "#77c4bd")
            xs = [p["generation"] for p in points]
            if index == 0:
                ax.plot(xs, [p["new"] for p in points], marker="o", label=label, color=color)
                plotted = True
            elif index == 1:
                found, fixed = [p["found"] for p in points], [p["fixed"] for p in points]
                ax.plot(xs, found, marker="o", label=label + ": found", color=color)
                ax.plot(xs, fixed, marker="s", linestyle="--", label=label + ": fixed", color=color)
                ax.fill_between(xs, fixed, found, color=color, alpha=.14)
                plotted = True
            elif index == 2:
                scored = [p for p in points if p["total"]]
                if scored:
                    ax.plot([p["generation"] for p in scored], [100 * p["pass"] / p["total"] for p in scored], marker="o", label=label, color=color)
                    for p in scored:
                        ax.annotate(f"{p['pass']}/{p['total']}", (p["generation"], 100 * p["pass"] / p["total"]), xytext=(0, 8), textcoords="offset points", ha="center", fontsize=9)
                    plotted = True
            else:
                fixes = []
                group = [r for r in rows if r["arm"] == arm]
                for seed in sorted({r["seed"] for r in group}):
                    latest = max((r for r in group if r["seed"] == seed), key=lambda r: r["generation"])
                    fixes.extend(latest["fix_generations"])
                if fixes:
                    ax.plot(range(1, len(fixes) + 1), fixes, marker="o", label=label, color=color)
                    plotted = True
        ax.set(title=title, xlabel=xlabel, ylabel=ylabel)
        ax.xaxis.set_major_locator(MaxNLocator(integer=True))
        if index != 2:
            ax.yaxis.set_major_locator(MaxNLocator(integer=True))
        ax.set_ylim(bottom=0)
        if index == 2:
            ax.set_ylim(-2, 108)
        ax.grid(alpha=.18)
        if not plotted:
            ax.text(.5, .5, "no run yet", transform=ax.transAxes, ha="center", va="center", color="#777777")
        else:
            ax.legend(fontsize=9, loc="best")
        fig.text(.01, .005, f"Run: {source.parent.name}. Real verifier evidence only. Missing generations are not invented.", fontsize=8, color="#666666")
        for extension in ("png", "svg"):
            target = directory / f"{stem}.{extension}"
            fig.savefig(target, dpi=180)
            paths.append(str(target))
        plt.close(fig)
    return {"rows": len(rows), "charts": 4, "files": paths}


if __name__ == "__main__":
    try:
        print(json.dumps(export(sys.argv[1])))
    except Exception as error:
        print(json.dumps({"error": "Chart export failed", "errorType": type(error).__name__}))
        sys.exit(1)
