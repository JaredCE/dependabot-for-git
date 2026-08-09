#!/usr/bin/env node
import { createPullRequests } from '../src/create-bitbucket-prs.mjs';

createPullRequests(process.argv.slice(2));
