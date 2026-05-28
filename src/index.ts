#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { scanCommand } from './commands/scan.js';
import { statusCommand } from './commands/status.js';
import { uninstallCommand } from './commands/uninstall.js';

const program = new Command();

program
  .name('driftguard')
  .description('Detect semantic drift in AI agent context files after code changes.')
  .version('1.0.0');

program.addCommand(initCommand());
program.addCommand(scanCommand());
program.addCommand(statusCommand());
program.addCommand(uninstallCommand());

program.parse();
