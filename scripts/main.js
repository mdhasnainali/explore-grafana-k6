// Single entry point for every k6 test type in this repo.
//
//   TEST_TYPE=smoke|load|stress|spike|soak|ramping_arrival_rate|all
//
// Configuration comes from .env (see .env.example); reports are written to
// RESULTS_DIR by handleSummary().

import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

import { config } from './lib/config.js';
import { buildScenarios, buildThresholds } from './lib/scenarios.js';
import { buildReports } from './lib/report.js';

export const options = {
  // Response bodies are still needed for the body check, so keep them.
  discardResponseBodies: false,
  scenarios: buildScenarios(config.testType),
  thresholds: buildThresholds(),
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // Tag every metric so reports can be sliced per environment.
  tags: { run_tag: config.report.runTag },
};

// Custom metrics: `errors` gives a single failure rate that also counts
// non-2xx responses, which http_req_failed alone does not always catch.
const errors = new Rate('endpoint_errors');
const latency = new Trend('endpoint_latency', true);

function sendRequest() {
  const { url, method, body, headers } = config.target;
  const payload = ['POST', 'PUT', 'PATCH'].includes(method) ? body || null : null;

  return http.request(method, url, payload, {
    headers,
    tags: { endpoint: url, method },
  });
}

export function setup() {
  const response = sendRequest();

  if (response.status === 0) {
    exec.test.abort(
      `Target unreachable: ${config.target.method} ${config.target.url} (${response.error || 'no response'})`
    );
  }

  console.log(
    `[setup] ${config.testType} | ${config.target.method} ${config.target.url} | probe status ${response.status}`
  );

  return { probeStatus: response.status };
}

export function apiTest() {
  const response = sendRequest();

  const ok = check(response, {
    'status is 2xx': (r) => r.status >= 200 && r.status < 300,
    'response body is not empty': (r) => r.body !== null && String(r.body).length > 0,
    [`duration under ${config.thresholds.p95Ms}ms`]: (r) => r.timings.duration < config.thresholds.p95Ms,
  });

  errors.add(!ok);
  latency.add(response.timings.duration);

  if (config.sleepSeconds > 0) {
    sleep(config.sleepSeconds);
  }
}

// k6 requires a default export; it simply delegates to the tagged scenario
// function so that `k6 run scripts/main.js` without scenarios still works.
export default function () {
  apiTest();
}

export function handleSummary(data) {
  return buildReports(data);
}
