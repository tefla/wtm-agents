#!/usr/bin/env bun

import { basename, resolve as resolvePath } from 'node:path';

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { DEFAULT_MODEL, WorkflowConfig } from './types';
import { runWorkflow } from './workflow';

const STDIN_FALLBACK_PROMPT = 'Coordinate the team to deliver the requested outcome.';

type CliArguments = {
  task?: string;
  repo: string;
  project?: string;
  defaultBranch?: string;
  registry?: string;
  model?: string;
  maxTurns?: number;
  json?: boolean;
  codexCommand?: string;
  codexArgs?: string[];
  clientSessionTimeoutSeconds?: number;
};

async function readPrompt(defaultPrompt?: string): Promise<string> {
  if (defaultPrompt && defaultPrompt.trim()) {
    return defaultPrompt.trim();
  }

  const { stdin } = process;
  if (stdin.isTTY) {
    return STDIN_FALLBACK_PROMPT;
  }

  stdin.setEncoding('utf8');
  let data = '';
  for await (const chunk of stdin) {
    data += chunk;
  }

  const trimmed = data.trim();
  return trimmed || STDIN_FALLBACK_PROMPT;
}

async function main(): Promise<void> {
  const parser = yargs(hideBin(process.argv))
    .scriptName('wtm-multi-agent')
    .command(
      '$0 [task]',
      'Run the multi-agent workflow',
      (commandYargs) =>
        commandYargs
          .positional('task', {
            type: 'string',
            describe: 'High-level request to execute. Reads stdin if omitted.',
          })
          .option('repo', {
            type: 'string',
            demandOption: true,
            describe: 'Path to the repository root for the active project.',
          })
          .option('project', {
            type: 'string',
            describe:
              'Friendly project name registered with BigBoss (default: repo folder name).',
          })
          .option('default-branch', {
            type: 'string',
            describe: 'Branch used as the base for new task worktrees (default: main).',
          })
          .option('registry', {
            type: 'string',
            describe: 'Path to the BigBoss SQLite registry database.',
          })
          .option('model', {
            type: 'string',
            default: DEFAULT_MODEL,
            describe: 'OpenAI model ID to use for all agents.',
          })
          .option('max-turns', {
            type: 'number',
            describe: 'Optional maximum number of turns for Runner.run.',
          })
          .option('json', {
            type: 'boolean',
            default: false,
            describe: 'Emit the final Runner result as JSON.',
          })
          .option('codex-command', {
            type: 'string',
            describe: 'Override the command used to launch Codex MCP (default: npx).',
          })
          .option('codex-arg', {
            type: 'string',
            array: true,
            describe: 'Override the arguments passed to the Codex MCP command (repeatable).',
          })
          .option('client-session-timeout-seconds', {
            type: 'number',
            describe: 'Override the Codex MCP client session timeout in seconds.',
          }),
    )
    .strict()
    .help();

  const argv = await parser.parseAsync();

  const cliArgs: CliArguments = {
    task: argv.task as string | undefined,
    repo: argv.repo as string,
    project: argv.project as string | undefined,
    defaultBranch: argv['default-branch'] as string | undefined,
    registry: argv.registry as string | undefined,
    model: argv.model as string | undefined,
    maxTurns: argv['max-turns'] as number | undefined,
    json: argv.json as boolean | undefined,
    codexCommand: argv['codex-command'] as string | undefined,
    codexArgs: (argv['codex-arg'] as string[] | undefined) ?? undefined,
    clientSessionTimeoutSeconds:
      (argv['client-session-timeout-seconds'] as number | undefined) ?? undefined,
  };

  const prompt = await readPrompt(cliArgs.task);
  const projectName = cliArgs.project ?? basename(resolvePath(cliArgs.repo));
  const defaultBranch = cliArgs.defaultBranch ?? 'main';

  const config: WorkflowConfig = {
    repoRoot: cliArgs.repo,
    projectName,
    defaultBranch,
    model: cliArgs.model,
    maxTurns: cliArgs.maxTurns,
    codexCommand: cliArgs.codexCommand,
    codexArgs: cliArgs.codexArgs,
    clientSessionTimeoutSeconds: cliArgs.clientSessionTimeoutSeconds,
    registryPath: cliArgs.registry,
  };

  try {
    const result = await runWorkflow(config, prompt);
    if (cliArgs.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result && typeof result === 'object' && 'finalOutput' in (result as any)) {
        const finalOutput = (result as any).finalOutput;
        if (typeof finalOutput === 'string') {
          console.log(finalOutput);
        } else {
          console.log(JSON.stringify(finalOutput, null, 2));
        }
      } else {
        console.log(String(result));
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(String(error));
    }
    process.exitCode = 1;
  }
}

main();
