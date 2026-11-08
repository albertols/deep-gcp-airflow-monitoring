# Security policy

DCAM is designed to be incapable of changing the environments it observes (spec §18.2). A way to make
DCAM send a mutating request, read data it promises not to read (Airflow configuration, connections,
variables, XCom), leak credentials, or reach a host outside its allowlist is a security issue.

## Reporting a vulnerability

Please **do not** open a public issue. Use GitHub's private vulnerability reporting
("Security" tab → "Report a vulnerability") on this repository. Include a minimal reproduction with
fictitious identifiers only.

We aim to acknowledge reports within 5 working days and to agree a disclosure date with you.

## Supported versions

Before 1.0, only the latest release and the `main` branch receive fixes.
