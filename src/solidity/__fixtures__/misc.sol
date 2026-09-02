// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @dev Inheritance scenario: `Derived` exposes `baseValue`, declared only in `Base`.
abstract contract Base {
    uint256 internal storedValue;

    /// @notice Returns the stored value, declared in the base contract.
    function baseValue() external view returns (uint256) {
        return storedValue;
    }

    function _setStored(uint256 v) internal {
        storedValue = v;
    }
}

contract Derived is Base {
    function bump(uint256 v) external {
        _setStored(v);
    }
}

/// @dev Access control scenario: `setFee` is gated by `onlyOwner`.
contract Access {
    address public owner;
    uint256 public fee;

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function setFee(uint256 newFee) external onlyOwner {
        fee = newFee;
    }
}

/// @dev Low-level call scenario: the destination and the selector are both dynamic.
contract Relay {
    address public trustedForwarder;

    function forward(address target, bytes calldata data) external returns (bool) {
        (bool ok, ) = target.call(data);
        return ok;
    }

    function ping() external view returns (bool) {
        (bool ok, ) = trustedForwarder.staticcall(abi.encodeWithSignature("ping()"));
        return ok;
    }
}
