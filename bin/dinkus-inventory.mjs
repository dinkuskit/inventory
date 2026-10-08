#!/usr/bin/env node
import { main } from "../src/cli/kernel.mjs";
import { spec } from "../src/cli/spec.mjs";
await main(spec);
