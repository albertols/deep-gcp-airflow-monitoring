# First run against a real environment

This guide is for the first time you run DCAM against a real Managed Airflow (Composer) environment. It also covers
the M1 reality check ([spec §22.5](spec/dcam-spec.md#225-m1-reality-check-spike)): the few platform facts this release
relies on that can only be confirmed on a real environment. The setup steps are in the
[README](../README.md#run-against-your-environment).

The repository is public. Never paste real project IDs, environment names, DAG IDs, host names or screenshots into
an issue or a commit. Replace them with `acme-…` names first.

## 1. Before DCAM starts: the doctor

```bash
pnpm dcam doctor                 # every environment; add --env <id> for one, --json for a report
```

Each check passes, warns or fails, with a fix you can copy. On a corporate laptop, these are the checks that matter:

| Check                  | What it tells you                                                                                                          | Reality-check item |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `network.proxy`        | Which proxy each call goes through (`HTTPS_PROXY`, `NO_PROXY`)                                                             | —                  |
| `network.ca-bundle`    | Your corporate root CA (`NODE_EXTRA_CA_CERTS` or `network.caBundlePath`) loads                                             | —                  |
| `adc.token`            | The Google Cloud CLI gave DCAM a token for your own identity                                                               | —                  |
| `composer.environment` | Composer API access (`roles/composer.viewer`) and the quota project                                                        | —                  |
| `airflow.version`      | Airflow 2.10 or later 2.x. Airflow 3 is reported as supported from M4                                                      | —                  |
| `airflow.health`       | The web server answers from your egress address, through the proxy                                                         | VC-18              |
| `airflow.role`         | DCAM can read DAGs; a warning when your Airflow role is broader than `Viewer` (Composer 3 registers new API users as `Op`) | VC-17              |
| `monitoring.read`      | Cloud Monitoring access (`roles/monitoring.viewer`)                                                                        | —                  |

If `airflow.health` fails with "The web server refused the request" (403), the cause is either the web server's
network access control or a missing Airflow role. The doctor cannot yet tell which (⚠️ VERIFY, VC-18): note which
one it turned out to be.

On Windows, if the doctor says the Google Cloud CLI is missing although `gcloud` works in your shell, note the exit
code it reports (⚠️ VERIFY: `cmd.exe` exits with 9009 when a command is not found).

## 2. The first hour: the DCAM health page

Start DCAM (`pnpm dcam`) and open **DCAM health**. In the first minutes you see the configuration and the DAG
inventory, then live snapshots and finished task instances. The history backfill reads the last 7 days of task
instances and 14 days of worker metrics in the background, within the request budget, with an ETA.

| Look at                             | What is normal                                                                           | Reality-check item |
| ----------------------------------- | ---------------------------------------------------------------------------------------- | ------------------ |
| Collectors                          | Every collector OK, or a short note saying it reads more next cycle                      | —                  |
| Airflow requests                    | At most 12 a minute with the `standard` profile (the default for `prod`)                 | —                  |
| Cloud Monitoring series, 24 h       | The number of series DCAM read. Note it after 24 hours                                   | VC-03              |
| "No Celery worker workload metrics" | Should not appear after the first cycles. If it stays, worker CPU and memory are unknown | ⚠️ VERIFY below    |
| Backfill                            | Running with an ETA, then complete. 7 days at 20,000 tries a day take about 10 hours     | —                  |

## 3. What to record

Keep these answers in a private note, with fictitious names only. Each answer either confirms a fact, so its ⚠️ VERIFY
marker can be removed, or refutes it, so the code changes:

1. **Worker workload type (⚠️ VERIFY, `worker-samples.ts`).** Does DCAM find the Celery worker type on its own? If it
   does not, check which values the `type` label of `cloud_composer_workload` has in Metrics Explorer.
2. **Page size (VC-11).** DCAM adapts on its own if Composer caps the task instance list below 100 rows a page, but
   the cap is not documented. One read-only call tells (with the `airflowUri` from
   `gcloud composer environments describe <environment> --location <region> --format='value(config.airflowUri)'`):

   ```bash
   curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" \
     "<airflowUri>/api/v1/dags/~/dagRuns/~/taskInstances?limit=100" | jq '[.total_entries, (.task_instances | length)]'
   ```

   A second number below 100 while the first is above 100 is the cap.

3. **Series per day (VC-03).** The health page's Cloud Monitoring series count after 24 hours.
4. **403 from the web server (VC-18).** Network access control or the Airflow role?
5. **Airflow role (VC-17).** Did the doctor report `Op` or higher? After an administrator changed it to `Viewer`,
   does the warning go away?
6. **Numbers you can check by hand.** Pick one DAG you know. Do the league's run count and run duration over 24 h
   match the Airflow UI's grid for the same day?

## Known limits of this release

- Only Airflow 2.10 or later 2.x. Airflow 3 environments are reported as supported from M4.
- 7-day ranges take about a second at 2,000 DAGs. 30-day ranges take a few seconds and 90-day ranges much longer,
  until the store keeps rollups.
- The critical path is estimated from timing, because DCAM does not read task dependencies. Inferred flakiness and
  hostname-based worker counts are labelled as upper or lower bounds.
