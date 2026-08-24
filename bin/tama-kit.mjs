#!/usr/bin/env node

import { run } from "../cli/index.mjs";

process.exitCode = await run(process.argv.slice(2));
