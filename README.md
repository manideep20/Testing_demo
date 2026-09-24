# Mobilewright Android tests

This workspace is ready for Android APK testing with Mobilewright.

## Add the APK

Place the APK at `apps/app.apk`, then update `bundleId` in `mobilewright.config.ts` to the app's Android package name.

## Connect a device

1. Install Android Studio and the Android SDK Platform Tools.
2. Enable USB debugging on a physical Android device, or boot an Android emulator.
3. Confirm the device is visible with `adb devices`.
4. Install Mobilewright's device agent with `npm run install:agent`.
5. Run the suite with `npm test`.

## Select the test user

`npm test` prompts once before execution:

```text
Select the SE user for this complete test run:

1. SU036 - Deepak Hooda (9833000103)
2. SU034 - Rajiv Nanda (9833000101)
3. SU059 - Sneha Kushwaha (9833000104)
4. SU035 - Sunita Malik (9833000102)

Enter user number:
```

The selected SE is used for every authenticated flow in the complete run. The runner always starts
from `TC-002` and executes suites in this order: Login, Start Day, MJP, Visit Flow, End Day. It does
not resume from the previous failed case. Login rejection tests still use their intentionally invalid
or non-SE identities because using the selected valid SE would invalidate those test cases.

For non-interactive execution, pass the same one-based selection explicitly:

```powershell
npm test -- --user 2
```

The selectable users are maintained in `test-data/test-users.json`. The runner reuses the valid test
password from `TC-002`, or `MOBILE_TEST_PASSWORD` when it is set. The VS Code **Run Mobilewright
Tests** task uses the same selector.

Useful commands:

- `npm run devices` lists Mobilewright devices.
- `npm run inspect` opens the Mobilewright inspector.
- `npm test -- --list` lists discovered tests without running them.

## Allure reporting

Use the project’s built-in Allure commands to produce and view a clean mobile automation report.

- `npm run test` — selects one SE, then runs the complete suite from the first test with the lightweight line reporter.
- `npm run test:mobilewright` — same lightweight test run using the Mobilewright script name.
- `npm run test:allure` — runs the suite and refreshes the Allure results directory before execution.
- `npm run test:report` — runs the suite with HTML and Allure reporters when full artifacts are required.
- `npm run allure:generate` — generates the HTML report from the latest `allure-results`.
- `npm run allure:open` — opens the generated report in the browser.
- `npm run allure:clean` — keeps only the latest 24 hours of results and report artifacts.
- `npm run allure:report` — generates and opens the latest report in one step.

`npm run allure:email` still packages the generated report into `allure-report.zip` and sends it via SMTP if the required environment variables are configured.

Copy `.env.example` to `.env` or set the same environment variables in the shell before running the email workflow. Replace the placeholder SMTP server, credentials, and `ALLURE_EMAIL_TO` addresses with your real values. Multiple recipients are comma-separated.

The interactive runner sets `MOBILE_TEST_USER` and `MOBILE_TEST_USER_NAME` from the selected user.
Set `MOBILE_TEST_PASSWORD` only when it should override the valid password stored with `TC-002`.
Direct Playwright execution still requires `MOBILE_TEST_USER`, `MOBILE_TEST_USER_NAME`, and
`MOBILE_TEST_PASSWORD`. Keep overrides in `.env`; the file is ignored by Git.