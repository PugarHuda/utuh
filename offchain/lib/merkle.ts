import { keccak256, solidityPacked } from 'ethers';

/// Check a Merkle proof against itself, before anything spends gas on it.
///
/// Every proof this repository submits comes from the hosted Proof Builder, and until now the
/// first thing that ever checked one was the Block Prover precompile — on chain, after the
/// transaction was signed, broadcast and paid for. A proof that does not hold reverts there, and
/// the claimant learns it from a failed transaction.
///
/// That is affordable for an append and expensive for a **refutation**, which is the one path with
/// a clock on it: a refuter is racing a challenge window, and a reverted transaction costs the gas
/// and the minutes. Re-deriving the root offline costs one keccak per sibling — eight or nine of
/// them for a normal block — and turns "the service said so" into something checked.
///
/// This does **not** make the proof true. It says the proof is internally consistent: the bytes,
/// the siblings and the root agree with each other. Whether that root is the one Creditcoin
/// attested is exactly what the precompile decides, and nothing off chain can answer it.
///
/// ## Why these two lines are here rather than imported
///
/// `@gluwa/usc-sdk` exports `hashLeaf` and `hashInner` and they are the definition. Importing them
/// is what this did first, and the console's bundle went from 312 KB to 827 KB: the SDK ships
/// CommonJS only — `main`, no `module`, no `exports` map — so pulling one function from it drags
/// `ethers/lib.commonjs` in beside the `lib.esm` the page already had. Half a megabyte for two
/// keccaks, on a page whose whole argument is that a stranger can open it and refute a claim.
///
/// So the rule is written out here against the ESM ethers already in the bundle, and
/// `npm run probe` asserts on every run that these agree with the SDK's own functions over a real
/// proof. The SDK stays the source of truth; it just does not have to be in the browser to be it.
/// A drift in the protocol's hashing shows up as a red daily job, not as a silent divergence.

/// The leaf rule: `keccak(abi.encodePacked(uint8(0x00), transactionBytes))`.
export function hashLeaf(leaf: string): string {
  return keccak256(solidityPacked(['uint8', 'bytes'], [0x00, leaf]));
}

/// The inner rule: `keccak(abi.encodePacked(uint8(0x01), left, right))`. The domain byte is what
/// keeps a leaf from ever being mistaken for an inner node.
export function hashInner(left: string, right: string): string {
  return keccak256(solidityPacked(['uint8', 'bytes32', 'bytes32'], [0x01, left, right]));
}

/// Fold a transaction and its siblings back into the root they claim.
export function merkleRootOf(
  encodedTransaction: string,
  siblings: readonly { hash: string; isLeft: boolean }[],
): string {
  let h = hashLeaf(encodedTransaction);
  for (const s of siblings) h = s.isLeft ? hashInner(s.hash, h) : hashInner(h, s.hash);
  return h;
}

/// Throw unless the proof hashes to the root it carries.
///
/// `what` names the thing being proven, so the message says which event failed rather than only
/// that something did.
export function assertFoldsToItsRoot(
  what: string,
  proof: { encodedTransaction: string; merkleRoot: string; siblings: readonly { hash: string; isLeft: boolean }[] },
): void {
  const folded = merkleRootOf(proof.encodedTransaction, proof.siblings);
  if (folded.toLowerCase() !== proof.merkleRoot.toLowerCase()) {
    throw new Error(
      `proof for ${what} does not hash to its own root: ${proof.siblings.length} sibling(s) fold to ` +
        `${folded}, and the proof claims ${proof.merkleRoot}. The builder returned something ` +
        `inconsistent; submitting it would revert on the Block Prover after paying for it.`,
    );
  }
}
