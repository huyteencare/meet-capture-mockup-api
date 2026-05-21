import { Router } from "express";

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Meet Capture — Benchmark Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
  h1 { font-size: 1.1rem; font-weight: 600; color: #94a3b8; margin-bottom: 20px; letter-spacing: .05em; text-transform: uppercase; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #1e293b; border-radius: 10px; padding: 16px 20px; }
  .card .label { font-size: .72rem; color: #64748b; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 6px; }
  .card .value { font-size: 1.8rem; font-weight: 700; color: #f1f5f9; }
  .card .value.error { color: #f87171; }
  .card .value.ok { color: #34d399; }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; }
  .chart-box { background: #1e293b; border-radius: 10px; padding: 16px 20px; }
  .chart-box h2 { font-size: .75rem; color: #64748b; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 12px; }
  .status-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 20px; font-size: .8rem; color: #64748b; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #34d399; animation: pulse 2s infinite; }
  .dot.offline { background: #f87171; animation: none; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
  .reset-btn { margin-left: auto; padding: 4px 14px; background: #1e293b; border: 1px solid #334155; color: #94a3b8; border-radius: 6px; font-size: .75rem; cursor: pointer; transition: .15s; }
  .reset-btn:hover { background: #ef4444; border-color: #ef4444; color: #fff; }
</style>
</head>
<body>
<h1>Meet Capture — Benchmark Dashboard</h1>
<div class="status-bar"><div class="dot" id="dot"></div><span id="status">Connecting…</span><button class="reset-btn" onclick="resetStats()">Reset Stats</button></div>
<div class="cards">
  <div class="card"><div class="label">Uptime</div><div class="value" id="c-uptime">—</div></div>
  <div class="card"><div class="label">CPU</div><div class="value" id="c-cpu">—</div></div>
  <div class="card"><div class="label">RAM (RSS)</div><div class="value" id="c-ram">—</div></div>
  <div class="card"><div class="label">Batches</div><div class="value" id="c-batches">—</div></div>
  <div class="card"><div class="label">Events</div><div class="value" id="c-events">—</div></div>
  <div class="card"><div class="label">Received</div><div class="value" id="c-mb">—</div></div>
  <div class="card"><div class="label">Files saved</div><div class="value" id="c-files">—</div></div>
  <div class="card"><div class="label">Disk used</div><div class="value" id="c-disk">—</div></div>
  <div class="card"><div class="label">GCS uploads</div><div class="value ok" id="c-s3">—</div></div>
  <div class="card"><div class="label">Active sessions</div><div class="value" id="c-active">—</div></div>
  <div class="card"><div class="label">Errors</div><div class="value error" id="c-errors">—</div></div>
</div>
<div class="charts">
  <div class="chart-box"><h2>CPU %</h2><canvas id="ch-cpu"></canvas></div>
  <div class="chart-box"><h2>RAM used (MB)</h2><canvas id="ch-ram"></canvas></div>
  <div class="chart-box"><h2>Batches / interval</h2><canvas id="ch-batches"></canvas></div>
  <div class="chart-box"><h2>Events / interval</h2><canvas id="ch-events"></canvas></div>
  <div class="chart-box"><h2>MB received / interval</h2><canvas id="ch-mb"></canvas></div>
  <div class="chart-box"><h2>Disk used (MB)</h2><canvas id="ch-disk"></canvas></div>
</div>
<script>
const POLL_MS = 10_000;
const MAX_POINTS = 40;
const labels = [];
let prev = null;

const mkChart = (id, color) => new Chart(document.getElementById(id), {
  type: "line",
  data: { labels, datasets: [{ data: [], borderColor: color, backgroundColor: color + "22", fill: true, tension: .35, pointRadius: 2 }] },
  options: { animation: false, plugins: { legend: { display: false } }, scales: {
    x: { ticks: { color: "#475569", maxTicksLimit: 6 }, grid: { color: "#1e293b" } },
    y: { ticks: { color: "#475569" }, grid: { color: "#334155" }, beginAtZero: true }
  }}
});

const charts = {
  cpu:     mkChart("ch-cpu",     "#f472b6"),
  ram:     mkChart("ch-ram",     "#a78bfa"),
  batches: mkChart("ch-batches", "#818cf8"),
  events:  mkChart("ch-events",  "#34d399"),
  mb:      mkChart("ch-mb",      "#f59e0b"),
  disk:    mkChart("ch-disk",    "#38bdf8"),
};

const push = (chart, value) => {
  chart.data.datasets[0].data.push(value);
  if (chart.data.datasets[0].data.length > MAX_POINTS) chart.data.datasets[0].data.shift();
  chart.update("none");
};

const fmt = (s) => { const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60; return h ? h+"h "+m+"m" : m ? m+"m "+sec+"s" : sec+"s"; };
const mb  = (b) => (b/1048576).toFixed(1) + " MB";

const poll = async () => {
  try {
    const res = await fetch("/api/stats");
    const d   = await res.json();
    const now = new Date().toLocaleTimeString();

    document.getElementById("dot").classList.remove("offline");
    document.getElementById("status").textContent = "Live · last update " + now + " · polling every " + (POLL_MS/1000) + "s";

    document.getElementById("c-uptime").textContent  = fmt(d.uptimeSeconds);
    document.getElementById("c-cpu").textContent     = (d.cpuPercent || 0).toFixed(1) + "%";
    document.getElementById("c-ram").textContent     = (d.memRssMB || 0) + " MB";
    document.getElementById("c-batches").textContent = d.totalBatchRequests;
    document.getElementById("c-events").textContent  = d.totalEvents;
    document.getElementById("c-mb").textContent      = mb(d.totalBytesReceived);
    document.getElementById("c-files").textContent   = d.totalSavedFiles;
    document.getElementById("c-disk").textContent    = mb(d.diskUsageBytes);
    document.getElementById("c-s3").textContent      = d.totalS3Uploads + (d.totalS3Errors > 0 ? " (" + d.totalS3Errors + " err)" : "");
    document.getElementById("c-s3").className        = "value " + (d.totalS3Errors > 0 ? "error" : "ok");
    document.getElementById("c-active").textContent  = d.activeSessionCount;
    document.getElementById("c-errors").textContent  = d.totalErrors;
    document.getElementById("c-errors").className    = "value " + (d.totalErrors > 0 ? "error" : "ok");

    if (labels.length >= MAX_POINTS) labels.shift();
    labels.push(now);

    push(charts.cpu,     +(d.cpuPercent || 0).toFixed(1));
    push(charts.ram,     d.memRssMB || 0);
    push(charts.batches, prev ? d.totalBatchRequests - prev.totalBatchRequests : 0);
    push(charts.events,  prev ? d.totalEvents - prev.totalEvents : 0);
    push(charts.mb,      prev ? +((d.totalBytesReceived - prev.totalBytesReceived)/1048576).toFixed(2) : 0);
    push(charts.disk,    +(d.diskUsageBytes/1048576).toFixed(1));

    prev = d;
  } catch {
    document.getElementById("dot").classList.add("offline");
    document.getElementById("status").textContent = "Offline · retrying…";
  }
};

const resetStats = async () => {
  if (!confirm("Reset all counters to 0?")) return;
  await fetch("/api/stats/reset", { method: "POST" });
  prev = null;
  poll();
};

poll();
setInterval(poll, POLL_MS);
</script>
</body>
</html>`;

export function createDashboardRouter({ counters, activeSessions, ACTIVE_SESSION_TTL_MS, serverStartMs, getCpuPercent, getDiskUsageBytes }) {
  const router = Router();

  router.get("/dashboard", (_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(DASHBOARD_HTML);
  });

  router.get("/api/stats", async (_req, res, next) => {
    try {
      const diskUsageBytes = await getDiskUsageBytes();
      const memRssMB = +(process.memoryUsage().rss / 1048576).toFixed(1);
      const activeSessionCount = [...activeSessions.values()].filter(t => Date.now() - t < ACTIVE_SESSION_TTL_MS).length;
      res.json({
        ok: true,
        uptimeSeconds: Math.floor((Date.now() - serverStartMs) / 1000),
        cpuPercent: +getCpuPercent().toFixed(1),
        memRssMB,
        ...counters,
        activeSessionCount,
        diskUsageBytes,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/stats/reset", (_req, res) => {
    for (const key of Object.keys(counters)) counters[key] = 0;
    res.json({ ok: true, resetAt: new Date().toISOString() });
  });

  return router;
}
