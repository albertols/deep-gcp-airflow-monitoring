"""acme_manual_backfill: no schedule; it runs only when triggered by hand (DCAM emulator).

The API reports `schedule_interval: null` for it. Fictitious DAG.
"""

import pendulum

from airflow import DAG
from airflow.operators.empty import EmptyOperator

with DAG(
    dag_id="acme_manual_backfill",
    schedule=None,
    start_date=pendulum.datetime(2026, 1, 1, tz="UTC"),
    catchup=False,
    default_args={"owner": "acme-ops"},
    tags=["acme"],
) as dag:
    EmptyOperator(task_id="acme_backfill_marker")
