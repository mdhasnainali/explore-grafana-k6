// End-of-test reporting. k6 calls handleSummary() once, after the test ends,
// and writes every key of the returned object to that path (or to stdout).
// Everything here is dependency-free so the script also runs without network
// access to jslib.k6.io.

import { config } from './config.js';
import { buildScenarios } from './scenarios.js';

function pad(value, width, char = ' ') {
  const text = String(value);
  return text.length >= width ? text : text + char.repeat(width - text.length);
}

function padLeft(value, width) {
  const text = String(value);
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

function round(value, digits = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return value;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatBytes(value) {
  if (value < 1024) return `${round(value)} B`;
  if (value < 1024 ** 2) return `${round(value / 1024)} kB`;
  if (value < 1024 ** 3) return `${round(value / 1024 ** 2)} MB`;
  return `${round(value / 1024 ** 3)} GB`;
}

// k6 tells us what a metric holds: `contains` is 'time' | 'data' | 'default',
// and `type` is 'counter' | 'gauge' | 'rate' | 'trend'. Using those instead of
// guessing from the metric name keeps custom metrics formatted correctly too.
function formatValue(metric, key, value) {
  if (typeof value !== 'number') {
    return String(value);
  }
  if (key === 'passes' || key === 'fails' || key === 'count') {
    return String(round(value, 4));
  }
  if (metric.type === 'rate' && key === 'rate') {
    return `${round(value * 100, 2)}%`;
  }
  if (key === 'rate') {
    // Counter rate: events per second.
    return `${round(value, 2)}/s`;
  }
  if (metric.contains === 'time') {
    return `${round(value)}ms`;
  }
  if (metric.contains === 'data') {
    return formatBytes(value);
  }
  return String(round(value, 4));
}

// Metrics shown first, in this order; everything else follows alphabetically.
const PRIORITY = [
  'http_reqs',
  'http_req_duration',
  'http_req_failed',
  'http_req_waiting',
  'iterations',
  'iteration_duration',
  'vus',
  'vus_max',
  'checks',
  'data_received',
  'data_sent',
  'dropped_iterations',
];

function sortedMetricNames(metrics) {
  const names = Object.keys(metrics);
  return names.sort((a, b) => {
    const ai = PRIORITY.indexOf(a);
    const bi = PRIORITY.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });
}

function thresholdResults(metrics) {
  const results = [];
  for (const [name, metric] of Object.entries(metrics)) {
    for (const [expression, result] of Object.entries(metric.thresholds || {})) {
      results.push({
        metric: name,
        threshold: expression,
        // k6 reports `ok: true` when the threshold passed.
        passed: result.ok !== false,
      });
    }
  }
  return results;
}

function flattenChecks(group, path = [], out = []) {
  if (!group) {
    return out;
  }
  const here = group.name ? [...path, group.name] : path;
  for (const check of group.checks || []) {
    out.push({
      name: check.name,
      path: here.join(' / '),
      passes: check.passes || 0,
      fails: check.fails || 0,
    });
  }
  for (const child of group.groups || []) {
    flattenChecks(child, here, out);
  }
  return out;
}

function meta(data) {
  const durationMs = (data.state && data.state.testRunDurationMs) || 0;
  return {
    runTag: config.report.runTag,
    testType: config.testType,
    target: `${config.target.method} ${config.target.url}`,
    startedAt: new Date(Date.now() - durationMs).toISOString(),
    finishedAt: new Date().toISOString(),
    durationSeconds: round(durationMs / 1000),
    thresholdConfig: config.thresholds,
    scenarios: Object.keys(buildScenarios(config.testType)),
  };
}

function renderText(data, info) {
  const lines = [];
  const rule = '-'.repeat(88);

  lines.push(rule);
  lines.push(`k6 report | ${info.testType} | ${info.runTag}`);
  lines.push(rule);
  lines.push(`Target      : ${info.target}`);
  lines.push(`Scenarios   : ${info.scenarios.join(', ') || 'n/a'}`);
  lines.push(`Started     : ${info.startedAt}`);
  lines.push(`Finished    : ${info.finishedAt}`);
  lines.push(`Duration    : ${info.durationSeconds}s`);
  lines.push('');

  const thresholds = thresholdResults(data.metrics || {});
  lines.push('Thresholds');
  if (thresholds.length === 0) {
    lines.push('  (none configured)');
  }
  for (const item of thresholds) {
    lines.push(`  [${item.passed ? 'PASS' : 'FAIL'}] ${item.metric} ${item.threshold}`);
  }
  lines.push('');

  lines.push('Metrics');
  for (const name of sortedMetricNames(data.metrics || {})) {
    const metric = data.metrics[name];
    const values = Object.entries(metric.values || {})
      .map(([key, value]) => `${key}=${formatValue(metric, key, value)}`)
      .join('  ');
    lines.push(`  ${pad(name, 34)} ${values}`);
  }
  lines.push('');

  const checks = flattenChecks(data.root_group);
  if (checks.length > 0) {
    lines.push('Checks');
    for (const check of checks) {
      const total = check.passes + check.fails;
      const rate = total === 0 ? 0 : (check.passes / total) * 100;
      lines.push(
        `  ${pad(check.name, 46)} ${padLeft(check.passes, 7)} pass ${padLeft(check.fails, 7)} fail ${padLeft(round(rate, 1), 6)}%`
      );
    }
    lines.push('');
  }

  const failed = thresholds.filter((item) => !item.passed);
  lines.push(rule);
  lines.push(failed.length === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failed.length} threshold(s) breached)`);
  lines.push(rule);

  return lines.join('\n') + '\n';
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHtml(data, info) {
  const thresholds = thresholdResults(data.metrics || {});
  const failedCount = thresholds.filter((item) => !item.passed).length;
  const checks = flattenChecks(data.root_group);

  const metricRows = sortedMetricNames(data.metrics || {})
    .map((name) => {
      const metric = data.metrics[name];
      const cells = Object.entries(metric.values || {})
        .map(([key, value]) => `<span class="kv"><b>${escapeHtml(key)}</b> ${escapeHtml(formatValue(metric, key, value))}</span>`)
        .join('');
      return `<tr><td class="name">${escapeHtml(name)}</td><td class="type">${escapeHtml(metric.type || '')}</td><td>${cells}</td></tr>`;
    })
    .join('\n');

  const thresholdRows = thresholds
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.metric)}</td><td><code>${escapeHtml(item.threshold)}</code></td>` +
        `<td class="${item.passed ? 'pass' : 'fail'}">${item.passed ? 'PASS' : 'FAIL'}</td></tr>`
    )
    .join('\n');

  const checkRows = checks
    .map((check) => {
      const total = check.passes + check.fails;
      const rate = total === 0 ? 0 : (check.passes / total) * 100;
      return `<tr><td>${escapeHtml(check.name)}</td><td>${escapeHtml(check.path)}</td><td>${check.passes}</td>` +
        `<td class="${check.fails > 0 ? 'fail' : ''}">${check.fails}</td><td>${round(rate, 1)}%</td></tr>`;
    })
    .join('\n');

  const httpDuration = (data.metrics && data.metrics.http_req_duration) || { values: {} };
  const httpReqs = (data.metrics && data.metrics.http_reqs) || { values: {} };
  const httpFailed = (data.metrics && data.metrics.http_req_failed) || { values: {} };

  const tiles = [
    ['Requests', round(httpReqs.values.count || 0)],
    ['Req/s', round(httpReqs.values.rate || 0)],
    ['p95', `${round(httpDuration.values['p(95)'] || 0)} ms`],
    ['p99', `${round(httpDuration.values['p(99)'] || 0)} ms`],
    ['avg', `${round(httpDuration.values.avg || 0)} ms`],
    ['Error rate', `${round((httpFailed.values.rate || 0) * 100, 2)}%`],
  ]
    .map(([label, value]) => `<div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${escapeHtml(value)}</div></div>`)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>k6 ${escapeHtml(info.testType)} report - ${escapeHtml(info.finishedAt)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f7f7f8; --card:#fff; --ink:#16181d; --muted:#5b6070; --line:#e3e5ea; --pass:#137a4b; --fail:#b3261e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14161a; --card:#1c1f25; --ink:#eceef2; --muted:#9aa1b1; --line:#2b2f37; --pass:#5fd39a; --fail:#ff8a80; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px 20px; background:var(--bg); color:var(--ink);
         font:14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  main { max-width:1040px; margin:0 auto; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 24px; }
  .verdict { display:inline-block; padding:4px 10px; border-radius:999px; font-weight:600; font-size:12px;
             letter-spacing:.04em; text-transform:uppercase; }
  .verdict.ok { background:color-mix(in srgb, var(--pass) 18%, transparent); color:var(--pass); }
  .verdict.bad { background:color-mix(in srgb, var(--fail) 18%, transparent); color:var(--fail); }
  section { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin:0 0 20px; }
  section h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:0 0 12px; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit, minmax(140px,1fr)); gap:12px; }
  .tile { border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .tile-label { color:var(--muted); font-size:12px; }
  .tile-value { font-size:20px; font-weight:600; margin-top:2px; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:6px 18px; margin:0; }
  dt { color:var(--muted); }
  dd { margin:0; word-break:break-all; }
  .scroll { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  td.name { font-weight:600; white-space:nowrap; }
  td.type { color:var(--muted); }
  .kv { display:inline-block; margin:0 14px 2px 0; white-space:nowrap; }
  .kv b { color:var(--muted); font-weight:500; }
  .pass { color:var(--pass); font-weight:600; }
  .fail { color:var(--fail); font-weight:600; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; }
</style>
</head>
<body>
<main>
  <h1>k6 ${escapeHtml(info.testType)} test</h1>
  <p class="sub">${escapeHtml(info.target)} &middot; ${escapeHtml(info.finishedAt)} &middot;
     <span class="verdict ${failedCount === 0 ? 'ok' : 'bad'}">${failedCount === 0 ? 'pass' : `fail (${failedCount})`}</span></p>

  <section>
    <h2>Summary</h2>
    <div class="tiles">${tiles}</div>
  </section>

  <section>
    <h2>Run</h2>
    <dl>
      <dt>Run tag</dt><dd>${escapeHtml(info.runTag)}</dd>
      <dt>Test type</dt><dd>${escapeHtml(info.testType)}</dd>
      <dt>Scenarios</dt><dd>${escapeHtml(info.scenarios.join(', ') || 'n/a')}</dd>
      <dt>Started</dt><dd>${escapeHtml(info.startedAt)}</dd>
      <dt>Finished</dt><dd>${escapeHtml(info.finishedAt)}</dd>
      <dt>Duration</dt><dd>${escapeHtml(info.durationSeconds)}s</dd>
    </dl>
  </section>

  <section>
    <h2>Thresholds</h2>
    <div class="scroll">
      <table>
        <thead><tr><th>Metric</th><th>Threshold</th><th>Result</th></tr></thead>
        <tbody>${thresholdRows || '<tr><td colspan="3">No thresholds configured.</td></tr>'}</tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Checks</h2>
    <div class="scroll">
      <table>
        <thead><tr><th>Check</th><th>Group</th><th>Passes</th><th>Fails</th><th>Rate</th></tr></thead>
        <tbody>${checkRows || '<tr><td colspan="5">No checks recorded.</td></tr>'}</tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Metrics</h2>
    <div class="scroll">
      <table>
        <thead><tr><th>Metric</th><th>Type</th><th>Values</th></tr></thead>
        <tbody>${metricRows}</tbody>
      </table>
    </div>
  </section>
</main>
</body>
</html>
`;
}

function renderCsv(data) {
  const rows = ['metric,type,stat,value'];
  for (const name of sortedMetricNames(data.metrics || {})) {
    const metric = data.metrics[name];
    for (const [key, value] of Object.entries(metric.values || {})) {
      rows.push(`${name},${metric.type || ''},${key},${round(value, 6)}`);
    }
  }
  return rows.join('\n') + '\n';
}

export function buildReports(data) {
  const info = meta(data);
  const stamp = info.finishedAt.replace(/[:.]/g, '-');
  // Flat file names on purpose: k6 writes summary files directly and does not
  // create missing directories, so everything lands in RESULTS_DIR itself.
  const prefix = `${config.report.dir}/${info.runTag}-${info.testType}-${stamp}`;

  const text = renderText(data, info);
  const html = renderHtml(data, info);
  const json = JSON.stringify({ meta: info, data }, null, 2);

  return {
    stdout: '\n' + text,

    // Timestamped files: full history of every run.
    [`${prefix}.json`]: json,
    [`${prefix}.txt`]: text,
    [`${prefix}.html`]: html,
    [`${prefix}.csv`]: renderCsv(data),

    // Stable paths that always point at the most recent run of this test type.
    [`${config.report.dir}/latest-${info.testType}.json`]: json,
    [`${config.report.dir}/latest-${info.testType}.html`]: html,
    [`${config.report.dir}/latest-${info.testType}.txt`]: text,
  };
}

export default buildReports;
