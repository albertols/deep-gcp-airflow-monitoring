"""acme_broken: a DAG file that fails to import, so the emulator always shows one import error.

Deliberately broken (DCAM emulator, FR-EMU-02): the module below does not exist.
"""

import acme_module_that_does_not_exist  # noqa: F401

from airflow import DAG  # noqa: F401
