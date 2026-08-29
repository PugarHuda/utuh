import type { Interface } from 'ethers';

/// Say why a call reverted, by the contract's own name for it.
///
/// Creditcoin's RPC puts revert data inside the error *message* — `VM Exception while processing
/// transaction: revert, data: "0x…"` — rather than in the `data` field ethers reads. ethers then
/// reports "execution reverted (unknown custom error)", which is true and useless: the contract
/// said `HistoryTooShort(4, 5)`, and a person who had been told that would have widened the range
/// instead of building two claims that could never open a line.
///
/// So the data is dug out of wherever the node put it and decoded against every interface the
/// caller is talking to. What comes back is the sentence the contract wrote.
export function explainRevert(e: unknown, interfaces: Interface[]): string {
  const err = e as {
    shortMessage?: string;
    message?: string;
    data?: string;
    revert?: { name: string; args: unknown[] };
    info?: { error?: { message?: string; data?: string } };
    error?: { message?: string; data?: string };
  };

  // ethers already decoded it — the ordinary chain's shape.
  if (err.revert?.name) return `${err.revert.name}(${err.revert.args.map(String).join(', ')})`;

  const data = revertData(err);
  if (data) {
    for (const iface of interfaces) {
      try {
        const parsed = iface.parseError(data);
        if (parsed) return `${parsed.name}(${parsed.args.map(String).join(', ')})`;
      } catch {
        /* not this contract's error */
      }
    }
    // Standard Error(string) and Panic(uint256) are on every interface; a selector nobody knows
    // is still worth showing rather than swallowing.
    return `reverted with ${data.slice(0, 10)}…`;
  }

  // A wallet's own refusal — "the decoy is locked", "request already pending" — arrives from
  // ethers as UNKNOWN_ERROR with the wallet's message nested inside and a shortMessage that
  // begins "could not coalesce error", which is ethers describing its own confusion. The person
  // wants the wallet's words.
  const inner = err.error?.message ?? err.info?.error?.message;
  if (inner && (err.shortMessage ?? '').startsWith('could not coalesce error')) return inner;
  return err.shortMessage ?? err.message ?? String(e);
}

/// The revert payload, from the `data` field if the node used it, else from the message text.
function revertData(err: {
  data?: string;
  message?: string;
  info?: { error?: { message?: string; data?: string } };
  error?: { message?: string; data?: string };
}): string | undefined {
  for (const candidate of [err.data, err.info?.error?.data, err.error?.data]) {
    if (typeof candidate === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(candidate)) return candidate;
  }
  for (const text of [err.message, err.info?.error?.message, err.error?.message]) {
    const m = typeof text === 'string' ? text.match(/data:\s*"?(0x[0-9a-fA-F]{8,})"?/) : null;
    if (m) return m[1]!;
  }
  return undefined;
}
