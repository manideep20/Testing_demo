import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const users = JSON.parse(
  readFileSync(new URL('../test-data/test-users.json', import.meta.url), 'utf8'),
).users;
const mobileCases = JSON.parse(
  readFileSync(new URL('../test-data/mobile-test-cases.json', import.meta.url), 'utf8'),
).testCases;

const orderedSpecs = [
  'tests/opanapp.spec.ts',
  'tests/start-day/start-day.spec.ts',
  'tests/mjp.spec.ts',
  'tests/visit-flow.spec.ts',
  'tests/end-day/end-day.spec.ts',
];

const args = process.argv.slice(2);
const userArgumentIndex = args.findIndex((argument) => argument === '--user');
const userArgument = userArgumentIndex >= 0 ? args[userArgumentIndex + 1] : undefined;
const forwardedArgs = args.filter((_argument, index) => (
  index !== userArgumentIndex && index !== userArgumentIndex + 1
));

if (forwardedArgs.includes('--last-failed')) {
  throw new Error('The selected-user runner always starts from the first test; --last-failed is not supported.');
}

const listOnly = forwardedArgs.includes('--list');
let selectedUser;

if (!listOnly) {
  console.log('\nSelect the SE user for this complete test run:\n');
  users.forEach((user, index) => {
    console.log(`${index + 1}. ${user.id} - ${user.name} (${user.mobileNumber})`);
  });

  const requestedSelection = userArgument ?? process.env.MOBILE_TEST_USER_INDEX;
  let answer = requestedSelection;
  if (!answer) {
    if (!stdin.isTTY) {
      throw new Error('User selection requires an interactive terminal or --user <number>.');
    }
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      answer = await prompt.question('\nEnter user number: ');
    } finally {
      prompt.close();
    }
  }

  const selectedIndex = Number.parseInt(answer.trim(), 10) - 1;
  selectedUser = users[selectedIndex];
  if (!selectedUser) {
    throw new Error(`Invalid user selection "${answer}". Choose a number from 1 to ${users.length}.`);
  }

  console.log(`\nRunning all tests as ${selectedUser.name} (${selectedUser.id}).`);
  console.log('Execution starts from the first login test and continues through every suite.\n');
}

const validLoginCase = mobileCases.find((testCase) => testCase.id === 'TC-002');
const password = process.env.MOBILE_TEST_PASSWORD
  ?? String(validLoginCase?.testData?.password ?? '');
if (!listOnly && !password) {
  throw new Error('No valid test password is configured in MOBILE_TEST_PASSWORD or TC-002 test data.');
}

const playwrightCli = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url));
const testEnvironment = selectedUser
  ? {
      ...process.env,
      MOBILE_TEST_USER: selectedUser.mobileNumber,
      MOBILE_TEST_USER_NAME: selectedUser.name,
      MOBILE_TEST_PASSWORD: password,
    }
  : process.env;

if (listOnly) {
  const result = spawnSync(
    process.execPath,
    [playwrightCli, 'test', '--config=mobilewright.config.ts', ...orderedSpecs, ...forwardedArgs],
    { cwd: process.cwd(), env: testEnvironment, stdio: 'inherit', windowsHide: true },
  );
  process.exitCode = result.status ?? 1;
} else {
  let failedSuites = 0;
  for (const spec of orderedSpecs) {
    console.log(`\n=== Running ${spec} ===\n`);
    const result = spawnSync(
      process.execPath,
      [playwrightCli, 'test', '--config=mobilewright.config.ts', spec, ...forwardedArgs],
      { cwd: process.cwd(), env: testEnvironment, stdio: 'inherit', windowsHide: true },
    );
    if (result.status !== 0) {
      failedSuites += 1;
      console.error(`\n${spec} finished with exit code ${result.status ?? 'unknown'}; continuing with the next suite.`);
    }
  }

  if (failedSuites > 0) {
    console.error(`\nCompleted all suites with ${failedSuites} failing suite(s).`);
    process.exitCode = 1;
  } else {
    console.log('\nAll suites completed successfully.');
  }
}
