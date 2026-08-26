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
export function runScript(main: () => Promise<unknown>): void {
  main()
    .then(() => process.exit(0))
    .catch((e: unknown) => {
      const err = e as { stack?: string; message?: string };
      console.error('\n' + (err?.stack ?? err?.message ?? String(e)));
      process.exit(1);
    });
}
