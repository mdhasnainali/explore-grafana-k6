// Scenario definitions for every test type, plus the helper that selects which
// ones to run based on TEST_TYPE.

import { config } from './config.js';

const EXEC = 'apiTest';

// Turn a k6 duration string ("30s", "1m", "1h30m") into seconds so that the
// "all" mode can chain scenarios one after another with startTime offsets.
export function durationToSeconds(duration) {
  const matches = String(duration).matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g);
  let seconds = 0;
  for (const [, value, unit] of matches) {
    const amount = Number(value);
    if (unit === 'ms') seconds += amount / 1000;
    else if (unit === 's') seconds += amount;
    else if (unit === 'm') seconds += amount * 60;
    else if (unit === 'h') seconds += amount * 3600;
  }
  return seconds;
}

function stagesDuration(stages) {
  return stages.reduce((total, stage) => total + durationToSeconds(stage.duration), 0);
}

const shape = config.shape;

// --- smoke: minimal load, verifies the endpoint and the script itself work ---
function smoke() {
  return {
    executor: 'constant-vus',
    vus: shape.smoke.vus,
    duration: shape.smoke.duration,
  };
}

// --- load: expected everyday traffic, held long enough to be meaningful ------
function load() {
  return {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: shape.load.rampUp, target: shape.load.vus },
      { duration: shape.load.steady, target: shape.load.vus },
      { duration: shape.load.rampDown, target: 0 },
    ],
    gracefulRampDown: '30s',
  };
}

// --- stress: step past normal load until the system starts to degrade -------
function stress() {
  const { maxVus, step } = shape.stress;
  const steps = [0.25, 0.5, 0.75, 1].map((fraction) => ({
    duration: step,
    target: Math.max(1, Math.round(maxVus * fraction)),
  }));
  return {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [...steps, { duration: step, target: 0 }],
    gracefulRampDown: '30s',
  };
}

// --- spike: sudden burst, then back to baseline, to test recovery -----------
function spike() {
  const { baseVus, peakVus } = shape.spike;
  return {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '10s', target: baseVus },
      { duration: '30s', target: baseVus },
      { duration: '10s', target: peakVus },
      { duration: '30s', target: peakVus },
      { duration: '10s', target: baseVus },
      { duration: '1m', target: baseVus },
      { duration: '10s', target: 0 },
    ],
    gracefulRampDown: '30s',
  };
}

// --- soak: moderate load over a long period, exposes leaks and drift --------
function soak() {
  return {
    executor: 'constant-vus',
    vus: shape.soak.vus,
    duration: shape.soak.duration,
  };
}

// --- ramping arrival rate: open model, throughput is the control knob -------
function rampingArrivalRate() {
  const rar = shape.rampingArrivalRate;
  return {
    executor: 'ramping-arrival-rate',
    startRate: rar.startRate,
    timeUnit: rar.timeUnit,
    preAllocatedVUs: rar.preAllocatedVUs,
    maxVUs: rar.maxVUs,
    stages: [
      { duration: '1m', target: rar.startRate },
      { duration: '2m', target: rar.peakRate },
      { duration: '2m', target: rar.peakRate },
      { duration: '1m', target: Math.max(1, Math.round(rar.startRate / 2)) },
      { duration: '30s', target: 0 },
    ],
  };
}

const BUILDERS = {
  smoke,
  load,
  stress,
  spike,
  soak,
  ramping_arrival_rate: rampingArrivalRate,
};

export const TEST_TYPES = Object.keys(BUILDERS);

// Order used by TEST_TYPE=all. Soak sits last because it is by far the longest.
const ALL_ORDER = ['smoke', 'load', 'stress', 'spike', 'ramping_arrival_rate', 'soak'];

function withMeta(name, scenario, startTime) {
  return Object.assign({}, scenario, {
    exec: EXEC,
    tags: { test_type: name },
    startTime: `${Math.round(startTime)}s`,
  });
}

function scenarioDuration(scenario) {
  if (scenario.stages) {
    return stagesDuration(scenario.stages) + durationToSeconds(scenario.gracefulRampDown || '0s');
  }
  return durationToSeconds(scenario.duration || '0s');
}

export function buildScenarios(testType) {
  if (testType === 'all') {
    const scenarios = {};
    let offset = 0;
    for (const name of ALL_ORDER) {
      const scenario = BUILDERS[name]();
      scenarios[name] = withMeta(name, scenario, offset);
      // 10s of breathing room so one scenario's ramp-down does not bleed into
      // the next one's measurements.
      offset += scenarioDuration(scenario) + 10;
    }
    return scenarios;
  }

  const builder = BUILDERS[testType];
  if (!builder) {
    throw new Error(
      `Unknown TEST_TYPE "${testType}". Use one of: ${TEST_TYPES.join(', ')}, all`
    );
  }
  return { [testType]: withMeta(testType, builder(), 0) };
}

export function buildThresholds() {
  const { p95Ms, p99Ms, errorRate } = config.thresholds;
  return {
    http_req_duration: [`p(95)<${p95Ms}`, `p(99)<${p99Ms}`],
    http_req_failed: [`rate<${errorRate}`],
    checks: ['rate>0.99'],
    // Dropped iterations only exist for arrival-rate executors; a non-zero
    // count means k6 could not keep up with the requested throughput.
    dropped_iterations: ['count<1'],
  };
}
