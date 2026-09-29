# Edge experiment charts
import csv, io, os
import numpy as np
import matplotlib.pyplot as plt
from matplotlib import font_manager

folder = '/content' if os.path.isdir('/content') else os.path.join('results', 'edge')
out = folder if folder == '/content' else os.path.join('results', 'edge', 'charts')
os.makedirs(out, exist_ok=True)

def read(name):
    path = os.path.join(folder, name)
    return list(csv.DictReader(open(path, encoding='utf-8'))) if os.path.exists(path) else []

summary = read('edge_summary.csv')
heartbeat = read('heartbeat_summary.csv')
LOADS = sorted({int(r['vehicles']) for r in summary})

def metric(mode, key):
    rows = {int(r['vehicles']): float(r[key]) if r[key] not in ('', 'null', 'undefined') else np.nan
            for r in summary if r['mode'] == mode}
    return np.array([rows.get(v, np.nan) for v in LOADS])

font = 'Liberation Serif' if any('Liberation Serif' in f.name for f in font_manager.fontManager.ttflist) else 'serif'
plt.rcParams.update({
    'font.family': font, 'font.size': 11,
    'axes.spines.top': False, 'axes.spines.right': False, 'axes.spines.left': True,
    'axes.edgecolor': '#9aa5b1', 'axes.grid': False, 'axes.axisbelow': True,
    'xtick.color': '#5b6675', 'ytick.color': '#5b6675', 'ytick.left': True,
    'legend.frameon': False, 'savefig.dpi': 300, 'savefig.bbox': 'tight',
})
# amber = before, blue = after
BEFORE, AFTER = '#e0a030', '#2f5d8a'
DEEP_TEAL = '#1c3b5a'
INK, MUTED = '#1f2a36', '#5b6675'
L_BEFORE = 'Before: cloud-only (every message sent to the cloud)'
L_AFTER = 'After: edge gateway (changes only, batched)'
x = np.arange(len(LOADS))
W = 0.36

def title(ax, main, sub):
    ax.set_title(main, loc='left', fontsize=14, fontweight='bold', color=INK, pad=24)
    ax.text(0, 1.02, sub, transform=ax.transAxes, fontsize=10.5, color=MUTED, va='bottom')

def fmt(v):
    return f'{v:,.0f}' if v >= 10 else f'{v:,.1f}'

def bars(ax, before, after, log=False):
    b1 = ax.bar(x - W/2 - 0.01, before, W, color=BEFORE, label=L_BEFORE, zorder=3)
    b2 = ax.bar(x + W/2 + 0.01, after, W, color=AFTER, label=L_AFTER, zorder=3)
    for vals, rects in ((before, b1), (after, b2)):
        for v, r in zip(vals, rects):
            if np.isnan(v):
                continue
            y = v * 1.12 if log else v + ax.get_ylim()[1] * 0.012
            ax.text(r.get_x() + r.get_width() / 2, y, fmt(v), ha='center', va='bottom', fontsize=9.5, color=INK)
    ax.set_xticks(x, [f'{v:,} vehicles' for v in LOADS])
    ax.legend(loc='upper left', fontsize=9.5)

def save(fig, name):
    fig.savefig(os.path.join(out, name))
    print('saved', os.path.join(out, name))
    plt.close(fig)

# 1. cloud messages
fig, ax = plt.subplots(figsize=(9, 4.8))
ax.set_yscale('log'); ax.minorticks_off()
before, after = metric('passthrough', 'upstream_msg_s'), metric('edge', 'upstream_msg_s')
ax.set_ylim(0.5, max(np.nanmax(before), 1) * 6)
bars(ax, before, after, log=True)
ax.set_ylabel('Messages per second sent to the cloud (log scale)')
title(ax, 'Messages sent to the cloud', 'The edge gateway sends about one batch per second, whatever the fleet size')
save(fig, 'hd_fig1_upstream_messages.png')

# 2. bandwidth
fig, ax = plt.subplots(figsize=(9, 4.8))
before, after = metric('passthrough', 'upstream_kb_s'), metric('edge', 'upstream_kb_s')
ax.set_ylim(0, np.nanmax(before) * 1.2)
bars(ax, before, after)
ax.set_ylabel('Data sent to the cloud (KB per second)')
title(ax, 'Network traffic to the cloud', 'Only vehicles whose status, crowding or delay changed are forwarded')
save(fig, 'hd_fig2_bandwidth.png')

# 3. alert latency
LAMBDA_P95_MS = {200: 1110, 500: 1270, 1000: 4540}  # from 6.3D
fig, ax = plt.subplots(figsize=(9, 4.8))
cloud = np.array([LAMBDA_P95_MS.get(v, np.nan) for v in LOADS], dtype=float)
edge = metric('edge', 'alert_latency_p95_ms')
ax.set_ylim(0, np.nanmax(cloud) * 1.2)
b1 = ax.bar(x - W/2 - 0.01, np.nan_to_num(cloud), W, color=BEFORE, label='Before: alert raised in the cloud (AWS Lambda, measured p95)', zorder=3)
b2 = ax.bar(x + W/2 + 0.01, edge, W, color=AFTER, label='After: alert raised at the edge gateway (p95)', zorder=3)
for vals, rects in ((cloud, b1), (edge, b2)):
    for v, r in zip(vals, rects):
        label = 'not tested' if np.isnan(v) else f'{v:,.0f} ms'
        ax.text(r.get_x() + r.get_width() / 2, (0 if np.isnan(v) else v) + ax.get_ylim()[1] * 0.012, label,
                ha='center', va='bottom', fontsize=9.5, color=MUTED if np.isnan(v) else INK)
ax.set_xticks(x, [f'{v:,} vehicles' for v in LOADS])
ax.set_ylabel('95th percentile alert latency (ms)')
ax.legend(loc='upper left', fontsize=9.5)
title(ax, 'How quickly passengers are alerted', 'Local alerts do not depend on the internet link or cloud scaling')
save(fig, 'hd_fig3_alert_latency.png')

# 4. traffic over time
busiest = LOADS[-1]
fig, ax = plt.subplots(figsize=(9, 4.4))
for mode, colour, label in (('passthrough', BEFORE, L_BEFORE), ('edge', AFTER, L_AFTER)):
    path = os.path.join(folder, f'{mode}-{busiest}-timeseries.csv')
    if os.path.exists(path):
        rows = list(csv.DictReader(open(path, encoding='utf-8')))
        ax.plot([int(r['second']) for r in rows], [int(r['upstream_messages']) for r in rows], color=colour, lw=2, label=label)
ax.set_yscale('log'); ax.minorticks_off()
ax.set_xlabel('Seconds into the test')
ax.set_ylabel('Messages per second (log scale)')
ax.legend(loc='center right', fontsize=9.5)
title(ax, f'Traffic to the cloud over time ({busiest:,} vehicles)', 'The edge output stays flat while the cloud-only link carries every message')
save(fig, 'hd_fig4_timeseries.png')

# 5. heartbeat
if heartbeat:
    hb = sorted(heartbeat, key=lambda r: int(r['mode'].split('hb')[1]))
    labels = [f"{r['mode'].split('hb')[1]} s" for r in hb]
    records = [float(r['records_to_cloud']) / (float(r['raw_messages']) or 1) * 100 for r in hb]
    stale = [float(r['staleness_p95_s']) for r in hb]
    acc = [float(r['status_accuracy_pct']) for r in hb]
    fig, axes = plt.subplots(1, 3, figsize=(11, 4))
    for ax, vals, colour, name, unit in ((axes[0], records, AFTER, 'Records forwarded', '% of raw messages'),
                                         (axes[1], stale, BEFORE, 'Staleness (p95)', 'seconds'),
                                         (axes[2], acc, DEEP_TEAL, 'Delay status accuracy', '% match with full data')):
        rects = ax.bar(labels, vals, 0.55, color=colour, zorder=3)
        top = max(vals) * 1.25
        ax.set_ylim((min(vals) - 3) if name.endswith('accuracy') else 0, top if not name.endswith('accuracy') else 100.5)
        for v, r in zip(vals, rects):
            ax.annotate(f'{v:.1f}', (r.get_x() + r.get_width() / 2, v), xytext=(0, 3), textcoords='offset points', ha='center', va='bottom', fontsize=9.5, color=INK)
        ax.set_title(name, loc='left', fontsize=11.5, fontweight='bold', color=INK)
        ax.set_ylabel(unit)
        ax.set_xlabel('Heartbeat interval')
    fig.suptitle('Heartbeat trade-off (500 vehicles)', x=0.01, ha='left', fontsize=14, fontweight='bold', color=INK)
    fig.tight_layout()
    save(fig, 'hd_fig5_heartbeat.png')

# billed messages per hour
print('\nEstimated billed IoT Core messages per hour (5 KB metering):')
for r in summary:
    msgs = float(r['upstream_msg_s'])
    size_kb = float(r['upstream_kb_s']) / msgs if msgs else 0
    billed = msgs * max(1, np.ceil(size_kb / 5)) * 3600
    print(f"  {r['mode']:<12} {int(r['vehicles']):>5} vehicles: {billed:>12,.0f} billed msgs/h (avg {size_kb:.1f} KB per message)")

# 6. outage
outage = read('outage_summary.csv')
if outage:
    fig, ax = plt.subplots(figsize=(9, 4.4))
    for mode, colour, label in (('passthrough', BEFORE, 'Before: cloud-only'), ('edge', AFTER, 'After: edge gateway')):
        path = os.path.join(folder, f'outage-{mode}-timeseries.csv')
        if os.path.exists(path):
            rows = {int(r['second']): int(r['cloud_messages']) for r in csv.DictReader(open(path, encoding='utf-8'))}
            secs = list(range(min(rows), max(rows) + 1))
            ax.plot(secs, [rows.get(t, np.nan) for t in secs], color=colour, lw=2, label=label, marker='o', markersize=2.5)
            peak = max(rows, key=rows.get)
            ax.annotate(f'{rows[peak]:,} in one second', (peak, rows[peak]), xytext=(8, 0), textcoords='offset points',
                        va='center', fontsize=9.5, color=colour)
    ax.axvspan(31.5, 31.5 + float(outage[0]['outage_s']), color='#9aa5b1', alpha=0.15, lw=0)
    ax.text(31.5 + float(outage[0]['outage_s']) / 2, 3, 'cloud unreachable:\nnothing received', ha='center', color=MUTED, fontsize=10)
    ax.set_yscale('log'); ax.minorticks_off()
    ax.set_ylim(0.5, 60000)
    ax.set_xlabel('Seconds into the test')
    ax.set_ylabel('Messages per second at the cloud (log scale)')
    ax.legend(loc='upper left', fontsize=9.5)
    title(ax, 'Behaviour during a 30 second cloud outage (500 vehicles)', 'On reconnection the cloud-only design releases its whole backlog in a single burst')
    save(fig, 'hd_fig6_outage.png')

# 7. adaptive vs fixed
adaptive = read('adaptive_summary.csv')
if adaptive:
    loads = sorted({int(r['vehicles']) for r in adaptive})
    def am(mode, key):
        rows = {int(r['vehicles']): float(r[key]) for r in adaptive if r['mode'] == mode}
        return np.array([rows.get(v, np.nan) for v in loads])
    panels = [('Records forwarded', '% of raw messages', lambda m: am(m, 'records_to_cloud') / am(m, 'raw_messages') * 100),
              ('Accuracy for late or crowded vehicles', '% match with full data', lambda m: am(m, 'critical_accuracy_pct')),
              ('Record age for late or crowded vehicles', 'p95 seconds', lambda m: am(m, 'critical_staleness_p95_s'))]
    fig, axes = plt.subplots(1, 3, figsize=(11.5, 4.2))
    xx = np.arange(len(loads))
    for ax, (name, unit, fn) in zip(axes, panels):
        for off, mode, colour, label in ((-0.2, 'edge', '#9aa5b1', 'Fixed thresholds'), (0.2, 'adaptive', AFTER, 'Adaptive (this work)')):
            vals = fn(mode)
            rects = ax.bar(xx + off, vals, 0.38, color=colour, label=label, zorder=3)
            for v, r in zip(vals, rects):
                ax.annotate(f'{v:.1f}', (r.get_x() + r.get_width() / 2, v), xytext=(0, 3), textcoords='offset points',
                            ha='center', va='bottom', fontsize=9, color=INK)
        ax.set_xticks(xx, [f'{v:,} veh.' for v in loads])
        ax.set_title(name, loc='left', fontsize=11, fontweight='bold', color=INK)
        ax.set_ylabel(unit)
        if 'Accuracy' in name:
            lo = np.nanmin([fn('edge'), fn('adaptive')])
            ax.set_ylim(max(0, lo - 6), 100.5)
        else:
            ax.set_ylim(0, np.nanmax([fn('edge'), fn('adaptive')]) * 1.25)
    axes[0].legend(loc='upper left', fontsize=9)
    fig.suptitle('Adaptive gateway: closer tracking of the vehicles that matter', x=0.01, ha='left', fontsize=14, fontweight='bold', color=INK)
    fig.tight_layout()
    save(fig, 'hd_fig7_adaptive.png')

# 8. multi-gateway
multi = read('multigateway_summary.csv')
if multi:
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(11.5, 4.2), gridspec_kw={'width_ratios': [1, 1.5]})
    gs = [int(r['gateways']) for r in multi]
    xx = np.arange(len(gs))
    meas = [float(r['cloud_msg_s']) for r in multi]
    cpu = [float(r['max_gateway_cpu_pct']) for r in multi]
    rects = a1.bar(xx - 0.2, meas, 0.38, color=AFTER, label='Cloud messages/s (measured)', zorder=3)
    import math
    model = [g * math.ceil(float(r['records_s']) / (g * 250)) for g, r in zip(gs, multi)]
    mr_ = a1.bar(xx + 0.2, model, 0.38, color='#9aa5b1', label='Model: Eq. (2)', zorder=3)
    for v, r in zip(model, mr_):
        a1.annotate(f'{v}', (r.get_x() + r.get_width() / 2, v), xytext=(0, 3), textcoords='offset points', ha='center', fontsize=9, color=MUTED)
    for v, r in zip(meas, rects):
        a1.annotate(f'{v:.2f}', (r.get_x() + r.get_width() / 2, v), xytext=(0, 3), textcoords='offset points', ha='center', fontsize=9, color=INK)
    for i, c in enumerate(cpu):
        a1.annotate(f'CPU {c:.1f}%', (xx[i], 0), xytext=(0, -26), textcoords='offset points', ha='center', fontsize=8.5, color=MUTED)
    a1.set_xticks(xx, [f'{g} gateway{"s" if g > 1 else ""}' for g in gs])
    a1.set_ylim(0, max(gs) * 1.35)
    a1.set_ylabel('Messages per second to the cloud')
    a1.legend(loc='upper left', fontsize=8.5)
    a1.set_title('Cloud load grows with depots, not vehicles', loc='left', fontsize=11, fontweight='bold', color=INK)
    G = max(gs)
    path = os.path.join(folder, f'multi-{G}-timeseries.csv')
    if os.path.exists(path):
        rows = list(csv.DictReader(open(path, encoding='utf-8')))
        t = [int(r['second']) for r in rows]
        palette = [AFTER, BEFORE, '#5b8fb9', '#1c3b5a', '#7f8c9a', '#b87333']
        for d in range(G):
            a2.plot(t, [int(r[f'records_depot{d}']) for r in rows], lw=1.4, color=palette[d % len(palette)],
                    label=f'Depot {d}' + (' (gateway stopped)' if d == 1 else ''))
        mr = next(r for r in multi if int(r['gateways']) == G)
        if mr.get('fail_sec') not in (None, ''):
            a2.axvspan(float(mr['fail_sec']), float(mr['restart_sec']), color='#9aa5b1', alpha=0.18, lw=0)
            a2.text((float(mr['fail_sec']) + float(mr['restart_sec'])) / 2, a2.get_ylim()[1] * 0.92, 'depot 1\ngateway down',
                    ha='center', va='top', fontsize=8.5, color=MUTED)
        a2.set_xlabel('Seconds into the test')
        a2.set_ylabel('Records per second reaching the cloud')
        a2.legend(loc='upper center', bbox_to_anchor=(0.5, -0.16), fontsize=8.5, ncol=4)
        a2.set_title(f'Failure isolation ({G} depots, one gateway stopped and restarted)', loc='left', fontsize=11, fontweight='bold', color=INK)
    fig.tight_layout()
    save(fig, 'hd_fig8_multigateway.png')
