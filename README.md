# Mobilewright Android tests

This workspace is ready for Android APK testing with Mobilewright.

## Add the APK

Place the APK at `apps/app.apk`, then update `bundleId` in `mobilewright.config.ts` to the app's Android package name.

## Connect a device

1. Install Android Studio and the Android SDK Platform Tools.
2. Enable USB debugging on a physical Android device, or boot an Android emulator.
3. Confirm the device is visible with `adb devices`.
4. Install Mobilewright's device agent with `npm run install:agent`.
5. Run the starter test with `npm test`.

Useful commands:

- `npm run devices` lists Mobilewright devices.
- `npm run inspect` opens the Mobilewright inspector.
- `npm test -- --list` lists discovered tests without running them.

## Allure reporting

Use the project’s built-in Allure commands to produce and view a clean mobile automation report.

- `npm run test` — runs the Mobilewright suite with the lightweight line reporter.
- `npm run test:mobilewright` — same lightweight test run using the Mobilewright script name.
- `npm run test:allure` — runs the suite and refreshes the Allure results directory before execution.
- `npm run test:report` — runs the suite with HTML and Allure reporters when full artifacts are required.
- `npm run allure:generate` — generates the HTML report from the latest `allure-results`.
- `npm run allure:open` — opens the generated report in the browser.
- `npm run allure:clean` — keeps only the latest 24 hours of results and report artifacts.
- `npm run allure:report` — generates and opens the latest report in one step.

`npm run allure:email` still packages the generated report into `allure-report.zip` and sends it via SMTP if the required environment variables are configured.

Copy `.env.example` to `.env` or set the same environment variables in the shell before running the email workflow. Replace the placeholder SMTP server, credentials, and `ALLURE_EMAIL_TO` addresses with your real values. Multiple recipients are comma-separated.

Authenticated app flows require `MOBILE_TEST_USER` and `MOBILE_TEST_PASSWORD`. Set
`MOBILE_TEST_USER_NAME` to the profile name shown by the app when session identity
verification is required. Keep these values in `.env`; the file is ignored by Git.