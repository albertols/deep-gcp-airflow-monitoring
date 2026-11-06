#!/usr/bin/env -S npx tsx
import { homedir } from 'node:os';
import {
  USAGE,
  VERSION,
  configFlagPath,
  createDoctorProbes,
  exitWhenFlushed,
  liveDoctorAdapters,
  parseCli,
  runDoctorCommand,
  start,
  type CliOptions,
} from './index';

let options: CliOptions | undefined;
try {
  options = parseCli(process.argv.slice(2));
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}

if (options?.command === 'help') console.log(USAGE);
else if (options?.command === 'doctor') {
  let code = 1;
  try {
    code = await runDoctorCommand(options, {
      probes: (configPath) =>
        createDoctorProbes({
          adapters: liveDoctorAdapters({
            configPath: configFlagPath(configPath, process.env, process.cwd()),
            env: process.env,
            cwd: process.cwd(),
            homeDir: homedir(),
          }),
        }),
      stdout: process.stdout,
      env: process.env,
      version: VERSION,
    });
  } catch (error) {
    console.error((error as Error).message);
  }
  // The report is out: exit now. Closing the connections gracefully would wait for requests still in
  // flight (up to 30 s), and a gcloud that is still running would keep the process open too.
  await exitWhenFlushed([process.stdout, process.stderr], code, (c) => process.exit(c));
} else if (options) {
  try {
    await start(options);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
