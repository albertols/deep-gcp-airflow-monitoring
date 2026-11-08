"""acme_ledger_small_pool: six tasks in a pool of two slots (DCAM emulator, FR-EMU-02).

`acme_small_pool` (2 slots, created by the emulator's init step) lets two tasks run at a time; the
other four wait as `scheduled` because the pool is full, although worker slots are free. The schedule
is a timedelta, so the API reports a `TimeDelta` schedule interval. Fictitious DAG; it only sleeps.
"""

import time
from datetime import timedelta

import pendulum

from airflow import DAG
from airflow.operators.python import PythonOperator


def _post_ledger() -> None:
    time.sleep(20)


with DAG(
    dag_id="acme_ledger_small_pool",
    schedule=timedelta(minutes=7),
    start_date=pendulum.datetime(2026, 1, 1, tz="UTC"),
    catchup=False,
    max_active_runs=1,
    default_args={"owner": "acme-finance", "retries": 0, "pool": "acme_small_pool"},
    tags=["acme", "pool"],
) as dag:
    for n in range(6):
        PythonOperator(task_id=f"acme_post_ledger_{n}", python_callable=_post_ledger)
