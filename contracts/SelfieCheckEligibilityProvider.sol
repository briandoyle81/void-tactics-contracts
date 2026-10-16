// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./IEligibilityProvider.sol";

// Selfie Check has no on-chain verification path (confirmed against World's
// own docs: verification is an off-chain REST call, unlike Orb's on-chain
// groupId=1 path Tournament.sol already uses), so this follows the pattern
// already established in the separate frontend repo for exactly this shape
// of problem — a backend verifies something off-chain (there: a Fireblocks
// Flow payment; here: a Selfie Check proof against World's verify API) and
// an authorized backend address relays the result on-chain, the same way
// Ships.isAllowedToCreateShips already authorizes other minters.
//
// Deliberately decoupled from FreeShipClaim.sol: the backend calls
// markVerified once (after confirming Selfie Check succeeded), and the
// player is then "eligible" for the verification's whole validity window —
// mirrors Selfie Check's own real 90-day inactivity window (confirmed via
// World's docs) rather than requiring a fresh backend round-trip on every
// single claim.
contract SelfieCheckEligibilityProvider is IEligibilityProvider, Ownable {
    // Backend addresses allowed to call markVerified — same authorized-caller
    // shape as Ships.isAllowedToCreateShips, just for a different actor (a
    // Selfie-Check-verifying backend, not a minter).
    mapping(address => bool) public authorizedVerifiers;

    // World ID nullifier -> already used. Prevents the same verified human
    // from being credited as newly-verified more than once across wallets.
    mapping(bytes32 => bool) public usedNullifiers;

    // World ID nullifier -> the wallet it's bound to. A Selfie Check
    // nullifier is stable per human, so this is what lets the SAME wallet
    // renew its 90-day verification (docs/audit-3.md HA6-14) while a
    // different wallet presenting the same human is still rejected.
    mapping(bytes32 => address) public nullifierOwner;

    // Per-player expiry of their Selfie Check verification.
    mapping(address => uint256) public verifiedUntil;

    uint256 public constant VERIFICATION_VALIDITY_PERIOD = 90 days;

    // Global kill switch for nullifier-uniqueness enforcement specifically —
    // lets the owner disable just that check (e.g. if World's nullifier
    // behavior needs bypassing, or a bug is found in this logic) without
    // disabling verification entirely.
    bool public nullifierCheckEnabled = true;

    event PlayerVerified(
        address indexed player,
        bytes32 indexed nullifierHash,
        uint256 verifiedUntil
    );
    event AuthorizedVerifierSet(address indexed verifier, bool isAuthorized);
    event NullifierCheckEnabledSet(bool enabled);
    event NullifierReleased(bytes32 indexed nullifierHash, address indexed previousOwner);

    error NotAuthorizedVerifier(address caller);
    error NullifierAlreadyUsed(bytes32 nullifierHash);

    constructor(address _initialOwner) Ownable(_initialOwner) {}

    function setAuthorizedVerifier(
        address _verifier,
        bool _isAuthorized
    ) external onlyOwner {
        authorizedVerifiers[_verifier] = _isAuthorized;
        emit AuthorizedVerifierSet(_verifier, _isAuthorized);
    }

    function setNullifierCheckEnabled(bool _enabled) external onlyOwner {
        nullifierCheckEnabled = _enabled;
        emit NullifierCheckEnabledSet(_enabled);
    }

    // Backend-only entry point. Called after the backend has independently
    // verified a Selfie Check proof against World's off-chain verify API —
    // this contract has no way to check that itself, so it trusts the
    // authorizedVerifiers allowlist.
    function markVerified(address _player, bytes32 _nullifierHash) external {
        if (!authorizedVerifiers[msg.sender]) {
            revert NotAuthorizedVerifier(msg.sender);
        }
        if (nullifierCheckEnabled) {
            address boundTo = nullifierOwner[_nullifierHash];
            if (boundTo == address(0)) {
                nullifierOwner[_nullifierHash] = _player;
                usedNullifiers[_nullifierHash] = true;
            } else if (boundTo != _player) {
                revert NullifierAlreadyUsed(_nullifierHash);
            }
            // boundTo == _player: a renewal — refresh the window below.
        }

        verifiedUntil[_player] = block.timestamp + VERIFICATION_VALIDITY_PERIOD;
        emit PlayerVerified(_player, _nullifierHash, verifiedUntil[_player]);
    }

    // For a real human who moved to a new wallet: frees their nullifier so
    // the new wallet can be verified, and immediately ends the old wallet's
    // verification so one human never backs two eligible wallets at once.
    function releaseNullifier(bytes32 _nullifierHash) external onlyOwner {
        address previousOwner = nullifierOwner[_nullifierHash];
        if (previousOwner != address(0)) {
            verifiedUntil[previousOwner] = 0;
        }
        delete nullifierOwner[_nullifierHash];
        usedNullifiers[_nullifierHash] = false;
        emit NullifierReleased(_nullifierHash, previousOwner);
    }

    function isEligible(address _player) external view returns (bool) {
        return verifiedUntil[_player] > block.timestamp;
    }
}
