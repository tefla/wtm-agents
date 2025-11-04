#!/usr/bin/env bun

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import {
  DEFAULT_DEVELOPER_DESCRIPTION,
  DEFAULT_MODEL,
  DeveloperDefinition,
  WorkflowConfig,
} from './types';
import { runWorkflow } from './workflow';

const DEFAULT_DEVELOPER_COUNT = 2;
const STDIN_FALLBACK_PROMPT =
  'Coordinate the team to deliver the requested outcome.';

type CliArguments = {
  task?: string;
  repo: string;
  wtm?: string;
  developer?: string[];
  developerCount: number;
  model?: string;
  maxTurns?: number;
  json?: boolean;
  codexCommand?: string;
  codexArgs?: string[];
  clientSessionTimeoutSeconds?: number;
};

function parseDeveloperSpec(rawSpec: string): DeveloperDefinition {
  const parts = rawSpec.split(',').map((chunk) => chunk.trim());
  const entries = new Map<string, string>();
  for (const part of parts) {
    const [key, value] = part.split('=');
    if (value === undefined) {
      throw new Error(
        `Invalid developer spec segment '${part}'. Expected key=value.`,
      );
    }
    entries.set(key.trim().toLowerCase(), value.trim());
  }

  const name = entries.get('name');
  const branch = entries.get('branch');
  if (!name || !branch) {
    throw new Error("Developer spec must include both 'name' and 'branch'.");
  }

  const description =
    entries.get('description') ?? DEFAULT_DEVELOPER_DESCRIPTION;
  const taskFileName = entries.get('task_file') ?? undefined;
  const statusFileName = entries.get('status_file') ?? undefined;

  return {
    name,
    branch,
    description,
    taskFileName,
    statusFileName,
  };
}

function resolveDevelopers(args: CliArguments): DeveloperDefinition[] {
  if (args.developer && args.developer.length > 0) {
    return args.developer.map((spec) => parseDeveloperSpec(spec));
  }

  const count = Math.max(1, args.developerCount ?? DEFAULT_DEVELOPER_COUNT);
  const developers: DeveloperDefinition[] = [];
  for (let index = 1; index <= count; index += 1) {
    developers.push({
      name: `Developer ${index}`,
      branch: `agents/dev-${index}`,
      description: DEFAULT_DEVELOPER_DESCRIPTION,
    });
  }
  return developers;
}

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
            describe: 'Path to the repository root managed by wtm.',
          })
          .option('wtm', {
            type: 'string',
            describe: 'Path to the `wtm` binary.',
          })
          .option('developer', {
            type: 'string',
            array: true,
            describe:
              "Developer specification in the form 'name=Dev,branch=agents/dev[,description=...]'.",
          })
          .option('developer-count', {
            type: 'number',
            default: DEFAULT_DEVELOPER_COUNT,
            describe:
              'Number of default developers when --developer is omitted (default: 2).',
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
            describe:
              'Override the arguments passed to the Codex MCP command (repeatable).',
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
    wtm: argv.wtm as string | undefined,
    developer: (argv.developer as string[] | undefined) ?? undefined,
    developerCount: argv['developer-count'] as number,
    model: argv.model as string | undefined,
    maxTurns: argv['max-turns'] as number | undefined,
    json: argv.json as boolean | undefined,
    codexCommand: argv['codex-command'] as string | undefined,
    codexArgs: (argv['codex-arg'] as string[] | undefined) ?? undefined,
    clientSessionTimeoutSeconds:
      (argv['client-session-timeout-seconds'] as number | undefined) ?? undefined,
  };

  const prompt = await readPrompt(cliArgs.task);
  const developers = resolveDevelopers(cliArgs);

  const config: WorkflowConfig = {
    repoRoot: cliArgs.repo,
    developers,
    model: cliArgs.model,
    wtmBinary: cliArgs.wtm,
    maxTurns: cliArgs.maxTurns,
    codexCommand: cliArgs.codexCommand,
    codexArgs: cliArgs.codexArgs,
    clientSessionTimeoutSeconds: cliArgs.clientSessionTimeoutSeconds,
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
