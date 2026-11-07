# DCAM emulator: a local Airflow 2.11.1

A real Airflow 2.11.1 with CeleryExecutor, Postgres and Redis on your machine, so that DCAM's Airflow side
can be developed and tested without Google Cloud (FR-EMU-02, spec §20). It is adapted from the
[official Airflow 2.11.1 Docker Compose file](https://airflow.apache.org/docs/apache-airflow/2.11.1/docker-compose.yaml).
Every DAG in it is fictitious (`acme_*`) and only sleeps.

## Before you start

- Docker Desktop (or Docker Engine with Compose v2) with at least 4 GB of memory and 2 CPUs.
- Port 8080 free on 127.0.0.1. The web server is published there only; Postgres and Redis are not published.
- The first start pulls images of about 2.7 GB (unpacked) and migrates the database: allow 5 to 10 minutes.

## Commands

| Command                                                                          | What it does                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `pnpm emulator:up`                                                               | Starts the emulator and waits until every service is healthy |
| `pnpm emulator:test`                                                             | Runs the airflow-v1 adapter's integration test against it    |
| `pnpm emulator:down`                                                             | Stops it and keeps the database, so the next start is quick  |
| `docker compose -f tools/emulator/docker-compose.yaml down -v`                   | Stops it and deletes the database and logs                   |
| `docker compose -f tools/emulator/docker-compose.yaml logs -f airflow-scheduler` | Follows the scheduler log                                    |

The Airflow UI is at http://127.0.0.1:8080 (user `airflow`, password `airflow`). The integration test polls until
the DAGs have produced task instances, so on a fresh start it can take a few minutes.

## Users

| User          | Role   | Default password | Variables                                                  |
| ------------- | ------ | ---------------- | ---------------------------------------------------------- |
| `airflow`     | Admin  | `airflow`        | `DCAM_EMULATOR_ADMIN_USER`, `DCAM_EMULATOR_ADMIN_PASSWORD` |
| `acme_viewer` | Viewer | `acme_viewer`    | `DCAM_EMULATOR_USER`, `DCAM_EMULATOR_PASSWORD`             |

DCAM uses the Viewer user: it is all DCAM needs (spec §18.3), and the doctor's privilege probe
(`GET /api/v1/providers`) reports `false` for it and `true` for the admin. Set the variables before the first
`pnpm emulator:up` to use other names or passwords; the init step creates the users once. These are local
development passwords only.

## Run DCAM against it

```bash
pnpm emulator:up
DCAM_EMULATOR_USER=acme_viewer DCAM_EMULATOR_PASSWORD=acme_viewer \
  pnpm dcam --config tools/emulator/dcam.config.emulator.yaml
```

In PowerShell, set the variables with `$env:DCAM_EMULATOR_USER = 'acme_viewer'` and
`$env:DCAM_EMULATOR_PASSWORD = 'acme_viewer'` first.

[`dcam.config.emulator.yaml`](dcam.config.emulator.yaml) declares one environment, `acme-emulator`, with an
`airflow:` block: basic authentication is accepted only for loopback URLs, and the credentials come from the
environment variables it names, never from the file.

## What the DAGs reproduce

| DAG                      | Schedule        | What it shows                                                                                                          |
| ------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `acme_orders_fan_out`    | `*/10 * * * *`  | A fan-out: 30 short tasks at once. With 4 worker slots and `parallelism` 8, most wait as `scheduled` or `queued`       |
| `acme_ledger_small_pool` | every 7 minutes | 6 tasks in `acme_small_pool` (2 slots): 4 wait as `scheduled` because the pool is full, although worker slots are free |
| `acme_partner_sensor`    | `*/5 * * * *`   | A poke-mode sensor that holds a worker slot for 4 of every 5 minutes while it waits                                    |
| `acme_manual_backfill`   | none            | An unscheduled DAG (`schedule_interval: null`)                                                                         |
| `acme_broken.py`         | ―               | A DAG file that fails to import: always one import error                                                               |

DAGs start unpaused, without catch-up, so data appears within minutes of start-up.

## Limits

These are mirrored in `dcam.config.emulator.yaml` (`airflow.limits`), because a self-managed Airflow has no
Composer API to read them from. Change both files together.

| Setting                           | Value |
| --------------------------------- | ----- |
| `[core] parallelism`              | 8     |
| `[core] max_active_tasks_per_dag` | 16    |
| `[core] max_active_runs_per_dag`  | 25    |
| `[celery] worker_concurrency`     | 4     |
| Celery workers                    | 1     |
| Schedulers                        | 1     |

## How it differs from Composer

- Basic authentication instead of a Google access token; the Airflow role model is the real one.
- Plain CeleryExecutor (Composer 3 runs CeleryKubernetesExecutor); one fixed worker, no autoscaling.
- No Composer API, Cloud Monitoring or Cloud Logging: DCAM's Google collectors stay idle for this environment.
  The fake Google APIs, the autoscaler simulator and the scenario library of spec §20.2 to §20.4 come later.
- The triggerer is optional, because the acme DAGs defer nothing:
  `docker compose -f tools/emulator/docker-compose.yaml --profile triggerer up -d`.
