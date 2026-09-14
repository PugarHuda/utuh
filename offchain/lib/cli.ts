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
/// The error path prints a refusal as its sentence and a bug with its stack — see `sentenceFor`.
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

/// What a failed script says, or null when the failure is a bug and deserves its stack.
///
/// Every refusal here is a plain `Error` whose message is the whole story — no key, no funds, a
/// usage line — and a stranger running `npm run balance` before writing a `.env` used to get that
/// sentence buried under ten frames of `node:internal`. A `TypeError` or its kin is a mistake in
/// this code, and there the line number is the story. ethers errors carry a `shortMessage`, which
/// drops the kilobyte of transaction hex a raw one prints; running out of gas money names the
/// account and the faucet.
export function sentenceFor(e: unknown): string | null {
  const err = e as { code?: string; shortMessage?: string; message?: string; transaction?: { from?: string } };
  if (err?.code === 'INSUFFICIENT_FUNDS') {
    // A contract deployment reaches here without `transaction.from`, so the address is only named when ethers had it.
    const who = err.transaction?.from;
    return (
      `${who ?? 'the PRIVATE_KEY account'} cannot pay for this transaction — it holds too little CTC on CC3 Testnet. ` +
      `Free CTC: join https://discord.gg/creditcoin and in #token-faucet run /faucet address:${who ?? '<its address, from npm run balance>'}`
    );
  }
  if (typeof err?.shortMessage === 'string') return err.shortMessage;
  if (e instanceof Error && Object.getPrototypeOf(e) === Error.prototype) return e.message;
  return null;
}

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
      // CI keeps the stack for every failure, and so does anyone who asks for it.
      const sentence = process.env.CI || process.env.UTUH_STACK ? null : sentenceFor(e);
      console.error('\n' + (sentence ?? err?.stack ?? err?.message ?? String(e)));
      process.exit(1);
    });
}
