#!/usr/bin/env -S npx tsx
import {
  USAGE,
  VERSION,
  createDoctorProbes,
  parseCli,
  runDoctorCommand,
  start,
  unwiredDoctorAdapters,
} from './index';

try {
  const options = parseCli(process.argv.slice(2));
  if (options.command === 'help') console.log(USAGE);
  else if (options.command === 'doctor') {
    process.exitCode = await runDoctorCommand(options, {
      // The composition root replaces unwiredDoctorAdapters with the config-file, gcp and airflow-v1
      // adapters on the guarded client (feature 002).
      probes: (configPath) => createDoctorProbes({ adapters: unwiredDoctorAdapters({ configPath }) }),
      stdout: process.stdout,
      env: process.env,
      version: VERSION,
    });
  } else await start(options);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
