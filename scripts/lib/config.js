// Central place where every environment variable is read and normalised.
// k6 exposes variables passed with `-e` / `--env` (or docker-compose `env_file`)
// on the global `__ENV` object.

function str(name, fallback) {
  const value = __ENV[name];
  return value === undefined || value === '' ? fallback : value;
}

function num(name, fallback) {
  const value = Number(__ENV[name]);
  return Number.isFinite(value) ? value : fallback;
}

const BASE_URL = str('BASE_URL', 'https://quickpizza.grafana.com').replace(/\/+$/, '');
const API_PATH = str('API_PATH', '/api/quotes');

function parseJsonEnv(name) {
  const raw = str(name, '');
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error.message}`);
  }
}

const headers = Object.assign(
  { 'Content-Type': 'application/json', Accept: 'application/json' },
  parseJsonEnv('EXTRA_HEADERS') || {}
);

const authToken = str('AUTH_TOKEN', '');
if (authToken) {
  headers.Authorization = `Bearer ${authToken}`;
}

export const config = {
  target: {
    url: API_PATH.startsWith('http') ? API_PATH : `${BASE_URL}${API_PATH}`,
    method: str('HTTP_METHOD', 'GET').toUpperCase(),
    body: str('REQUEST_BODY', ''),
    headers,
  },

  testType: str('TEST_TYPE', 'smoke').toLowerCase().replace(/-/g, '_'),
  sleepSeconds: num('SLEEP_SECONDS', 1),

  thresholds: {
    p95Ms: num('P95_MS', 500),
    p99Ms: num('P99_MS', 1000),
    errorRate: num('ERROR_RATE', 0.01),
  },

  report: {
    dir: str('RESULTS_DIR', '/results').replace(/\/+$/, ''),
    runTag: str('RUN_TAG', 'local'),
  },

  shape: {
    smoke: {
      vus: num('SMOKE_VUS', 1),
      duration: str('SMOKE_DURATION', '30s'),
    },
    load: {
      vus: num('LOAD_VUS', 50),
      rampUp: str('LOAD_RAMP_UP', '1m'),
      steady: str('LOAD_STEADY', '3m'),
      rampDown: str('LOAD_RAMP_DOWN', '1m'),
    },
    stress: {
      maxVus: num('STRESS_MAX_VUS', 300),
      step: str('STRESS_STEP', '1m'),
    },
    spike: {
      baseVus: num('SPIKE_BASE_VUS', 10),
      peakVus: num('SPIKE_PEAK_VUS', 500),
    },
    soak: {
      vus: num('SOAK_VUS', 50),
      duration: str('SOAK_DURATION', '1h'),
    },
    rampingArrivalRate: (() => {
      const startRate = num('RAR_START_RATE', 10);
      const peakRate = num('RAR_PEAK_RATE', 200);
      const timeUnit = str('RAR_TIME_UNIT', '1s');
      // An arrival-rate executor needs roughly `rate x iteration duration` VUs
      // to sustain the target rate. Under-allocating shows up as
      // dropped_iterations during the ramp, so derive the default from the peak
      // rate instead of hardcoding it. One iteration costs the think time plus
      // ~1s of assumed request time.
      const iterationCost = num('SLEEP_SECONDS', 1) + 1;
      const needed = Math.max(1, Math.ceil(peakRate * iterationCost));
      return {
        startRate,
        peakRate,
        timeUnit,
        preAllocatedVUs: num('RAR_PREALLOCATED_VUS', needed),
        maxVUs: num('RAR_MAX_VUS', needed * 2),
      };
    })(),
  },
};

export default config;
