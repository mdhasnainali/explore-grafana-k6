# explore-grafana-k6

API load-testing harness built on [Grafana k6](https://grafana.com/docs/k6/latest/), run through Docker.
One script covers six test types — smoke, load, stress, spike, soak, ramping arrival rate — against an
endpoint configured entirely through `.env`. Every run writes a report (text, HTML, JSON, CSV) to `results/`.

## Layout

```
.env.example          # every knob, documented — copy to .env
docker-compose.yml    # one runner service per test type
scripts/
  main.js             # entry point: scenarios, checks, thresholds, summary hook
  lib/config.js       # reads and validates __ENV
  lib/scenarios.js    # the six load shapes + threshold definitions
  lib/report.js       # end-of-test report rendering (txt / html / json / csv)
  script.js           # original single-file quickstart, kept for reference
results/              # generated reports (git-ignored)
```

## Setup

```bash
cp .env.example .env
# point BASE_URL / API_PATH at the endpoint you want to test
$EDITOR .env
```

`K6_UID` / `K6_GID` in `.env` decide which user the container runs as, so report files land on the
host owned by you instead of root. Match them to `id -u` / `id -g`.

## Run

```bash
docker compose run --rm smoke          # 1 VU, 30s   — does it work at all
docker compose run --rm load           # 50 VUs, 5m  — expected traffic
docker compose run --rm stress         # → 300 VUs   — find the breaking point
docker compose run --rm spike          # 10 → 500 → 10 VUs — burst and recovery
docker compose run --rm soak           # 50 VUs, 1h  — leaks and drift
docker compose run --rm arrival-rate   # 10 → 200 req/s — throughput-driven
docker compose run --rm all            # all six, sequentially (~1h20m)

docker compose run --rm k6             # whatever TEST_TYPE says in .env
```

Override any variable per run without editing `.env`:

```bash
docker compose run --rm -e LOAD_VUS=200 -e LOAD_STEADY=10m load
docker compose run --rm -e RUN_TAG=staging -e BASE_URL=https://staging.example.com load
```

Without Docker (needs k6 installed locally):

```bash
set -a && source .env && set +a
RESULTS_DIR=./results k6 run scripts/main.js
```

## Test types

| Type | Executor | Shape | Answers |
|---|---|---|---|
| `smoke` | `constant-vus` | 1 VU, 30s | Script and endpoint are sane. Run before anything else. |
| `load` | `ramping-vus` | ramp 1m → 50 VUs, hold 3m, ramp down 1m | Performance under normal traffic. |
| `stress` | `ramping-vus` | 4 steps to 300 VUs, 1m each, then down | Where does it start to degrade. |
| `spike` | `ramping-vus` | 10 VUs → 500 VUs for 30s → back to 10 | Survives a sudden burst, and recovers. |
| `soak` | `constant-vus` | 50 VUs for 1h | Memory leaks, connection-pool exhaustion, slow drift. |
| `ramping_arrival_rate` | `ramping-arrival-rate` | 10 → 200 iterations/s | Behaviour at a fixed *throughput*, VUs added as needed. |

Closed vs open model matters: `*-vus` executors wait for each response before sending the next request,
so a slow server automatically reduces the request rate. `ramping-arrival-rate` keeps sending at the
target rate regardless — a slow server shows up as `dropped_iterations` instead of as lower throughput.

`TEST_TYPE=all` chains every scenario with `startTime` offsets and a 10s gap between them, so results
stay attributable per phase (each scenario tags its metrics with `test_type`).

## Configuration

All variables live in `.env.example` with comments. The ones you will touch most:

| Variable | Default | Meaning |
|---|---|---|
| `BASE_URL` | `https://quickpizza.grafana.com` | Host under test, no trailing slash |
| `API_PATH` | `/api/quotes` | Endpoint path (or a full URL, which wins over `BASE_URL`) |
| `HTTP_METHOD` | `GET` | `GET` / `POST` / `PUT` / `PATCH` / `DELETE` |
| `REQUEST_BODY` | empty | JSON body, single line, used for `POST`/`PUT`/`PATCH` |
| `AUTH_TOKEN` | empty | Sent as `Authorization: Bearer <token>` when set |
| `EXTRA_HEADERS` | empty | JSON object of extra headers, e.g. `{"X-Api-Key":"abc"}` |
| `TEST_TYPE` | `smoke` | Which test the plain `k6` service runs |
| `P95_MS` / `P99_MS` | `500` / `1000` | Latency thresholds |
| `ERROR_RATE` | `0.01` | Max tolerated request failure rate |
| `SLEEP_SECONDS` | `1` | Think time between iterations |
| `RESULTS_DIR` | `/results` | Report output dir (container path) |
| `RUN_TAG` | `local` | Free-form label written into every report file name |

Load shapes are tunable too — `LOAD_VUS`, `STRESS_MAX_VUS`, `SPIKE_PEAK_VUS`, `SOAK_DURATION`,
`RAR_PEAK_RATE`, and friends. See `.env.example`.

### Thresholds

A run exits non-zero when any threshold is crossed, which makes it usable as a CI gate:

- `http_req_duration`: `p(95) < P95_MS`, `p(99) < P99_MS`
- `http_req_failed`: `rate < ERROR_RATE`
- `checks`: `rate > 0.99`
- `dropped_iterations`: `count < 1` (arrival-rate executors could not keep up)

The per-request checks are status is 2xx, body is not empty, and duration under `P95_MS`. That last
check means slow responses fail both `http_req_duration` and `checks` — deliberate, so a single
`RESULT: FAIL` line is enough to know something is wrong.

## Reports

`handleSummary()` writes, per run, into `results/`:

| File | Contents |
|---|---|
| `<tag>-<type>-<timestamp>.txt` | Same human-readable summary that is printed to stdout |
| `<tag>-<type>-<timestamp>.html` | Standalone report: summary tiles, thresholds, checks, all metrics |
| `<tag>-<type>-<timestamp>.json` | Full raw k6 summary plus run metadata, for diffing or dashboards |
| `<tag>-<type>-<timestamp>.csv` | `metric,type,stat,value` rows, for spreadsheets |
| `latest-<type>.{txt,html,json}` | Overwritten each run — stable paths for scripts and bookmarks |

Timestamped files are never overwritten, so `results/` is a run history. Open the HTML report with:

```bash
xdg-open results/latest-smoke.html
```

Reports carry no colour codes and no external assets, so they are safe to attach to a CI artifact or
paste into a ticket. File names are flat rather than nested in per-run directories because k6 writes
summary files directly and does not create missing directories.

For time-series output instead of an end-of-test summary, add a k6 output flag to the command, e.g.
`command: run --out json=/results/raw.json /scripts/main.js`.

## Notes

- `setup()` sends one probe request before the load starts and aborts the run if the target is
  unreachable, so a typo in `BASE_URL` fails in seconds instead of after a full ramp.
- The probe request counts toward `http_reqs` but not toward `iterations`, which is why the two
  differ by one.
- In k6's `http_req_failed` output, `passes` counts *failed* requests — read the `rate` line instead.
- Run `smoke` first after any config change. Everything else assumes the endpoint already answers.
