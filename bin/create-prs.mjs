#!/usr/bin/env node
import { createPullRequests } from '../src/create-prs.mjs';

createPullRequests(process.argv.slice(2));
