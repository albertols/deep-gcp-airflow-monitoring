#!/usr/bin/env -S npx tsx
import { homedir } from 'node:os';
import {
  USAGE,
  VERSION,
  createDoctorProbes,
  liveDoctorAdapters,
  parseCli,
  runDoctorCommand,
  start,
  type LiveDoctorAdapters,
} from './index';

try {
  const options = parseCli(process.argv.slice(2));
  if (options.command === 'help') console.log(USAGE);
  else if (options.command === 'doctor') {
    let adapters: LiveDoctorAdapters | undefined;
    try {
      process.exitCode = await runDoctorCommand(options, {
        probes: (configPath) => {
          adapters = liveDoctorAdapters({
            configPath,
            env: process.env,
            cwd: process.cwd(),
            homeDir: homedir(),
          });
          return createDoctorProbes({ adapters });
        },
        stdout: process.stdout,
        env: process.env,
        version: VERSION,
      });
    } finally {
      await adapters?.close();
    }
  } else await start(options);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
