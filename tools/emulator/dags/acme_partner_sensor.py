"""acme_partner_sensor: a poke-mode sensor that holds a worker slot while it waits (DCAM emulator).

Every 5 minutes the sensor checks every 10 seconds and succeeds 4 minutes after it started. In poke
mode the task keeps its worker slot for the whole wait, so one of the four worker slots is busy most
of the time (DCAM's advisor suggests mode="reschedule"). Fictitious DAG.
"""

import pendulum

from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.sensors.python import PythonSensor


def _partner_file_arrived(ti) -> bool:
    return (pendulum.now("UTC") - ti.start_date).total_seconds() >= 240


def _import_partner_file() -> None:
    pass


with DAG(
    dag_id="acme_partner_sensor",
    schedule="*/5 * * * *",
    start_date=pendulum.datetime(2026, 1, 1, tz="UTC"),
    catchup=False,
    max_active_runs=1,
    default_args={"owner": "acme-data", "retries": 0},
    tags=["acme", "sensor"],
) as dag:
    wait = PythonSensor(
        task_id="acme_wait_for_partner_file",
        python_callable=_partner_file_arrived,
        mode="poke",
        poke_interval=10,
        timeout=600,
    )
    wait >> PythonOperator(task_id="acme_import_partner_file", python_callable=_import_partner_file)
