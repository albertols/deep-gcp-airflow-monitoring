"""acme_orders_fan_out: thirty short tasks in parallel, then a join (DCAM emulator, FR-EMU-02).

With one worker of concurrency 4 and `parallelism` 8, most of the thirty tasks wait: some as
`scheduled` (the scheduler queues no more than `parallelism`), some as `queued` (Celery has no free
worker slot). Fictitious DAG; it only sleeps.
"""

import time

import pendulum

from airflow import DAG
from airflow.operators.python import PythonOperator


def _load_shard(shard: int) -> None:
    time.sleep(4 + shard % 5)


def _join() -> None:
    pass


with DAG(
    dag_id="acme_orders_fan_out",
    description="Thirty short tasks in parallel.",
    schedule="*/10 * * * *",
    start_date=pendulum.datetime(2026, 1, 1, tz="UTC"),
    catchup=False,
    max_active_runs=1,
    default_args={"owner": "acme-data", "retries": 0},
    tags=["acme", "fan-out"],
) as dag:
    join = PythonOperator(task_id="acme_join", python_callable=_join)
    for shard in range(30):
        load = PythonOperator(
            task_id=f"acme_load_shard_{shard:02d}",
            python_callable=_load_shard,
            op_kwargs={"shard": shard},
        )
        load >> join
