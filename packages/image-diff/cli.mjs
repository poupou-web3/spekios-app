#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { compareFiles } from './index.mjs';

const usage = 'Usage: node cli.mjs --before before.png --after after.png --out new-directory --before-id capture-1 --after-id capture-2';
try {
  const { values } = parseArgs({
    options: {
      before: { type: 'string' }, after: { type: 'string' }, out: { type: 'string' },
      'before-id': { type: 'string' }, 'after-id': { type: 'string' }, help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(usage);
  } else {
    for (const required of ['before', 'after', 'out', 'before-id', 'after-id']) {
      if (!values[required]) throw new Error(`Missing --${required}. ${usage}`);
    }
    const metadata = await compareFiles({
      beforePath: values.before, afterPath: values.after, outputDirectory: values.out,
      beforeCaptureId: values['before-id'], afterCaptureId: values['after-id'],
    });
    console.log(JSON.stringify({ difference_id: metadata.difference_id, ...metadata.counts, geometry_changed: metadata.geometry_changed }));
  }
} catch (error) {
  console.error(`Image comparison failed: ${error.message}`);
  process.exitCode = 1;
}
