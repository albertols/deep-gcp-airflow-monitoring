#!/usr/bin/env -S npx tsx
import { USAGE, doctor, parseCli, start } from './cli';

try {
  const options = parseCli(process.argv.slice(2));
  if (options.command === 'help') console.log(USAGE);
  else if (options.command === 'doctor') process.exitCode = (await doctor()) ? 0 : 1;
  else await start(options);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
