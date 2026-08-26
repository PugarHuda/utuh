/// The two Solidity enums, mirrored once.
///
/// `UtuhRegistry.Status` and `UtuhCredit.LineStatus` are enums, and Solidity enums reach an ABI as
/// a bare `uint8` — the names exist only in the source. Something off-chain has to carry them, and
/// until now six files each carried their own copy. One of those copies was wrong: it called
/// LineStatus 2 "Repaid", a status this system does not have, and that name reached the deck and
/// the submission notes before anyone compared it with the contract.
///
/// `test_theEnumsAreWhatTheOffchainMirrorSays` in test/UtuhCredit.t.sol pins the numbering these
/// arrays assume, so reordering an enum breaks a test that names this file.
const CLAIM_STATUS = ['None', 'Open', 'Sealed', 'Finalized', 'Refuted'] as const;
const LINE_STATUS = ['None', 'Active', 'Settled', 'Defaulted'] as const;

/// A claim's status by name, or the raw value when the contract knows something this does not.
export function claimStatus(s: bigint | number): string {
  return CLAIM_STATUS[Number(s)] ?? String(s);
}

/// A line's status by name, with the same fallback.
export function lineStatus(s: bigint | number): string {
  return LINE_STATUS[Number(s)] ?? String(s);
}
