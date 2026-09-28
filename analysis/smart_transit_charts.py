# Load-test charts. Reads summary.csv and the timeseries CSVs from /content
# (Google Colab) or results/ (local).
import csv, io, os
import numpy as np
import matplotlib.pyplot as plt
from matplotlib import font_manager

folder = '/content' if os.path.isdir('/content') else 'results'
files = {}
for name in sorted(os.listdir(folder)):
    if name.endswith('.csv'):
        files[name] = open(os.path.join(folder, name), encoding='utf-8').read()
print('CSV files found:', ', '.join(files) or 'none - upload them to the Files panel first')
IN_COLAB = folder == '/content'

def find(prefix):
    for name in sorted(files):
        if name.startswith(prefix) and '(' not in name:
            return files[name]
    for name in sorted(files):
        if name.startswith(prefix):
            return files[name]
    return None

summary = list(csv.DictReader(io.StringIO(find('summary'))))
LOADS = sorted({int(r['vehicles']) for r in summary})

def metric(pipeline, key):
    rows = {int(r['vehicles']): float(r[key]) for r in summary if r['pipeline'] == pipeline}
    return np.array([rows.get(v, np.nan) for v in LOADS])

font = 'Liberation Serif' if any('Liberation Serif' in f.name for f in font_manager.fontManager.ttflist) else 'serif'
plt.rcParams.update({
    'font.family': font, 'font.size': 11,
    'axes.spines.top': False, 'axes.spines.right': False, 'axes.spines.left': False,
    'axes.edgecolor': '#8fa3a8', 'axes.grid': True, 'axes.grid.axis': 'y',
    'grid.color': '#e4ecec', 'grid.linewidth': 0.8, 'axes.axisbelow': True,
    'xtick.color': '#56636a', 'ytick.color': '#56636a', 'ytick.left': False,
    'legend.frameon': False, 'savefig.dpi': 300, 'savefig.bbox': 'tight',
})
# terracotta = single server (before), teal = Lambda (after)
BEFORE, AFTER = '#c8553d', '#1a9e96'
DEEP_TEAL = '#0e5f5a'
INK, MUTED, TARGET = '#1f2a2e', '#56636a', '#8fa3a8'
L_BEFORE = 'Before: single server (EC2)'
L_AFTER = 'After: AWS Lambda (auto-scaling)'
x = np.arange(len(LOADS))
W = 0.36
saved = []

def title(ax, main, sub):
    ax.set_title(main, loc='left', fontsize=14, fontweight='bold', color=INK, pad=24)
    ax.text(0, 1.02, sub, transform=ax.transAxes, fontsize=10.5, color=MUTED, va='bottom')

def bars(ax, before, after, fmt, pad, labels=True):
    b1 = ax.bar(x - W/2 - 0.01, np.nan_to_num(before), W, color=BEFORE, label=L_BEFORE, zorder=3)
    b2 = ax.bar(x + W/2 + 0.01, after, W, color=AFTER, label=L_AFTER, zorder=3)
    for vals, bar_set in ((before, b1), (after, b2)):
        for v, rect in zip(vals, bar_set):
            cx = rect.get_x() + rect.get_width() / 2
            if np.isnan(v):
                ax.text(cx, pad, 'not\nrun', ha='center', va='bottom', fontsize=8, color=MUTED)
            elif labels:
                ax.text(cx, v + pad, fmt(v), ha='center', va='bottom', fontsize=9, color=INK)
    ax.set_xticks(x, [f'{v}' for v in LOADS])
    ax.set_xlabel('Simulated vehicles (1 message per vehicle per second)')
    ax.tick_params(axis='x', length=0)

def save(fig, name):
    fig.savefig(name); saved.append(name); plt.close(fig)

# Fig 1: throughput
fig, ax = plt.subplots(figsize=(9, 4.8))
bars(ax, metric('baseline', 'throughput_msg_s'), metric('lambda', 'throughput_msg_s'), lambda v: f'{v:.0f}', 12)
ax.set_ylabel('Messages processed per second')
ax.set_ylim(0, max(LOADS) * 1.12)
title(ax, 'Throughput: the single server stops at about 100 msg/s',
      'Lambda keeps pace up to 500 vehicles and reaches 915 msg/s at 1,000 (baseline not run beyond its limit)')
ax.legend(loc='upper left', fontsize=10)
save(fig, 'fig1_throughput.png')

# Fig 2: message loss
fig, ax = plt.subplots(figsize=(9, 4.8))
bars(ax, metric('baseline', 'loss_pct'), metric('lambda', 'loss_pct'), lambda v: f'{v:g}%', 1)
ax.set_ylabel('Messages lost (%)')
ax.set_ylim(0, 58)
title(ax, 'Message loss by load',
      'Single server loses 47% at 200 vehicles; Lambda stays under 0.2% until the 1,000-vehicle spike (7%)')
ax.legend(loc='upper left', fontsize=10)
save(fig, 'fig2_message_loss.png')

# Fig 3: latency (median and p95)
fig, axes = plt.subplots(1, 2, figsize=(12, 4.8), sharey=True)
for ax, key, name in [(axes[0], 'latency_p50_ms', 'Median (p50)'),
                      (axes[1], 'latency_p95_ms', '95th percentile (p95)')]:
    bars(ax, metric('baseline', key) / 1000, metric('lambda', key) / 1000, lambda v: f'{v:.2f}', 0.05)
    ax.axhline(3, color=TARGET, lw=1.2, ls=(0, (4, 3)), zorder=2)
    ax.text(-0.45, 3.06, 'Plan target: 3 s', fontsize=9, color=MUTED)
    ax.set_title(name, loc='left', fontsize=12, color=INK, pad=6)
    ax.set_ylim(0, 5.0)
axes[0].set_ylabel('End-to-end latency (seconds)')
fig.suptitle('Latency under load: Lambda stays near 1 s until the 1,000-vehicle spike',
             x=0.01, ha='left', fontsize=14, fontweight='bold', color=INK)
handles, labels = axes[0].get_legend_handles_labels()
fig.legend(handles, labels, loc='lower center', ncol=2, bbox_to_anchor=(0.5, -0.06), fontsize=10.5)
fig.text(0.01, -0.12, 'Latency = time from the vehicle sending a message (Melbourne) to the result being stored '
         'in DynamoDB (us-east-1); about 0.6 s of it is network distance, common to both versions.',
         fontsize=9, color=MUTED)
fig.tight_layout(rect=(0, 0, 1, 0.95))
save(fig, 'fig3_latency.png')

def timeseries(prefix):
    text = find(prefix)
    if text is None:
        return None
    rows = list(csv.DictReader(io.StringIO(text)))
    s = np.array([int(r['second']) for r in rows])
    n = np.array([int(r['messages']) for r in rows])
    p95 = np.array([float(r['latency_p95_ms']) for r in rows]) / 1000
    smooth = np.convolve(p95, np.ones(5) / 5, mode='same')
    return s, p95, smooth, n

# Fig 4: 200-vehicle timeline, before vs after
tb, tl = timeseries('base-200'), timeseries('lambda-200')
if tb and tl:
    fig, ax = plt.subplots(figsize=(8, 4.8))
    for (s, raw, smooth, _), color, label in [(tb, BEFORE, L_BEFORE), (tl, AFTER, L_AFTER)]:
        ax.plot(s, raw, color=color, lw=0.8, alpha=0.25)
        ax.plot(s[2:-2], smooth[2:-2], color=color, lw=2.2, label=label)
    ax.axhline(3, color=TARGET, lw=1.2, ls=(0, (4, 3)))
    ax.text(119, 3.08, 'Plan target (3 s)', fontsize=9, color=MUTED, ha='right')
    ax.set_xlabel('Seconds into the 200-vehicle test')
    ax.set_ylabel('p95 latency (seconds, 5 s rolling average)')
    ax.set_ylim(0, 4.6); ax.set_xlim(0, 120)
    ax.grid(axis='x', visible=False)
    title(ax, 'Second by second at 200 vehicles',
          'The single server builds a backlog (up to 4 s); Lambda holds steady at about 1 s')
    ax.legend(loc='upper right', fontsize=10)
    save(fig, 'fig4_latency_over_time_200.png')

# Fig 5: improvement summary at 200 vehicles
i200 = LOADS.index(200)
b = {k: metric('baseline', k)[i200] for k in ['throughput_msg_s', 'loss_pct', 'latency_p50_ms', 'latency_p95_ms']}
a = {k: metric('lambda', k)[i200] for k in b}
cards = [
    ('Throughput', f"{b['throughput_msg_s']:.0f} → {a['throughput_msg_s']:.0f} msg/s", f"{a['throughput_msg_s'] / b['throughput_msg_s']:.1f}× higher"),
    ('Messages lost', f"{b['loss_pct']:.1f}% → {a['loss_pct']:.0f}%", 'no data lost'),
    ('Median latency', f"{b['latency_p50_ms']/1000:.2f} → {a['latency_p50_ms']/1000:.2f} s", f"{(1 - a['latency_p50_ms'] / b['latency_p50_ms']) * 100:.0f}% lower"),
    ('p95 latency', f"{b['latency_p95_ms']/1000:.2f} → {a['latency_p95_ms']/1000:.2f} s", f"{(1 - a['latency_p95_ms'] / b['latency_p95_ms']) * 100:.0f}% lower"),
]
fig, axes = plt.subplots(1, 4, figsize=(12, 2.6))
for ax, (label, change, gain) in zip(axes, cards):
    ax.axis('off')
    ax.add_patch(plt.Rectangle((0.02, 0.02), 0.96, 0.96, transform=ax.transAxes,
                               facecolor='#eef7f6', edgecolor='#cfe5e2', lw=1.2))
    ax.text(0.08, 0.78, label, transform=ax.transAxes, fontsize=11, color=MUTED)
    ax.text(0.08, 0.47, gain, transform=ax.transAxes, fontsize=20, fontweight='bold', color=DEEP_TEAL)
    ax.text(0.08, 0.18, change, transform=ax.transAxes, fontsize=11, color=INK)
fig.suptitle('Improvement at 200 vehicles: single server → AWS Lambda', x=0.01, ha='left',
             fontsize=14, fontweight='bold', color=INK)
fig.tight_layout(rect=(0, 0, 1, 0.93))
save(fig, 'fig5_improvement_summary.png')

# Fig 6: 1,000-vehicle stress test timeline (Lambda)
t = timeseries('lambda-1000')
if t:
    s, raw, smooth, n = t
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(8, 5.6), sharex=True, gridspec_kw={'height_ratios': [1, 1]})
    ax1.bar(s, n, width=0.9, color=AFTER, zorder=3)
    ax1.axhline(1000, color=TARGET, lw=1.2, ls=(0, (4, 3)))
    ax1.text(119, 1015, 'sent: 1,000 msg/s', fontsize=9, color=MUTED, ha='right', va='bottom')
    ax1.set_ylabel('Messages processed\nper second')
    ax1.set_ylim(0, 1150)
    ax2.plot(s, raw, color=AFTER, lw=0.8, alpha=0.3)
    ax2.plot(s[2:-2], smooth[2:-2], color=DEEP_TEAL, lw=2.2)
    ax2.axhline(3, color=TARGET, lw=1.2, ls=(0, (4, 3)))
    ax2.text(119, 3.08, 'Plan target (3 s)', fontsize=9, color=MUTED, ha='right')
    ax2.set_ylabel('p95 latency (s)')
    ax2.set_xlabel('Seconds into the 1,000-vehicle Lambda test')
    ax2.set_ylim(0, max(6, raw.max() * 1.1)); ax2.set_xlim(-1, 120)
    for ax in (ax1, ax2):
        ax.grid(axis='x', visible=False)
        ax.axvspan(-1, 36, color='#fbefec', zorder=0)
    ax1.text(1, 1080, 'scale-up phase: throttling', fontsize=9.5, color=BEFORE, va='top')
    ax1.text(40, 1080, 'steady state: all messages processed', fontsize=9.5, color=DEEP_TEAL, va='top')
    title(ax1, 'Breaking point: the 1,000-vehicle spike',
          'Lambda is throttled while it scales out, then recovers to ~1,000 msg/s at under 1 s')
    fig.tight_layout()
    save(fig, 'fig6_stress_1000.png')

print('Saved:', ', '.join(saved))
if IN_COLAB:
    from IPython.display import Image, display
    from google.colab import files as colab_files
    for name in saved:
        display(Image(name))
        colab_files.download(name)
