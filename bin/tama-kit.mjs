#!/usr/bin/env node
// @ts-check

import { run } from "../cli/index.mjs";

process.exitCode = await run(process.argv.slice(2));
