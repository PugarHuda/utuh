/// How every script here starts and stops.
///
/// There were two epilogues. Six scripts ended with `main().then(() => process.exit(0)).catch(...)`
/// and nine with `main().catch(...)` alone, and the difference is not cosmetic: the first exits
/// whatever else is still holding the event loop open, the second waits for it to drain and hangs
/// if a provider was never destroyed. Both worked, which is the problem — the next script would
/// have picked whichever it was copied from.
///
/// This is the first form, deliberately. These are one-shot commands that open several RPC
/// providers and do not all destroy them, and a command that has printed its answer should not
/// then sit there. `npm run watch` is the exception and never returns from `main` at all.
///
/// The error path prints the stack when there is one, because these fail against a live chain and
/// the line number is usually the whole story.
///
/// The success path exits with `process.exitCode`, not with 0, and the difference is not academic.
/// `liveTest.ts` ends with `if (failed > 0) process.exitCode = 1` and then returns normally, having
/// reported its own failures rather than thrown — and `process.exit(0)` overrides that, so
/// `npm run livetest` returned success no matter how many of its assertions failed. Measured: a
/// script that sets exitCode 1 and returns exited 0. Anything reading the exit code rather than the
/// output was being told the suite passed.
/// Whether a script has already taken over this process.
///
/// Importing a module that calls `runScript` at its top level *runs that script*, and if the
/// importer is itself a script the two mains race: two sets of transactions from one key, and
/// whichever finishes first calls `process.exit` on the other. That happened — `cureDemo` imported
/// one helper from `redeployCredit`, and the demonstration silently redeployed a contract and
/// rewrote the deployment record.
///
/// The fix was to move the helper into a library. This is the second lock: the next time somebody
/// reaches into a script for something, they get a sentence explaining it instead of a race.
let running = false;

export function runScript(main: () => Promise<unknown>): void {
  if (running) {
    throw new Error(
      'two scripts are starting in one process. Something imported a module that calls runScript ' +
        'at its top level — move the thing being borrowed into offchain/lib/ instead.',
    );
  }
  running = true;

  main()
    .then(() => process.exit(Number(process.exitCode ?? 0)))
    .catch((e: unknown) => {
      const err = e as { stack?: string; message?: string };
      console.error('\n' + (err?.stack ?? err?.message ?? String(e)));
      process.exit(1);
    });
}
