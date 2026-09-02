// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev A free (file-level) struct, the common MetaMorpho/Morpho-Blue shape.
struct MarketParams {
    address loanToken;
    address collateralToken;
    uint256 lltv;
}

/// @dev A struct that nests another struct and carries an array member.
struct Allocation {
    MarketParams market;
    uint256[] shares;
}

enum Status {
    Idle,
    Active,
    Paused
}

/// @dev A user defined value type over a primitive.
type Id is bytes32;

interface IAdapter {
    function ping() external;
}

contract TypesDemo {
    /// @notice Takes a single struct parameter.
    function acceptCap(MarketParams calldata params) external returns (uint256) {
        return params.lltv;
    }

    /// @notice Takes an array of a struct that itself nests another struct.
    function reallocate(Allocation[] calldata allocations) external returns (uint256) {
        return allocations.length;
    }

    /// @notice Takes a user defined value type.
    function revokePendingCap(Id id) external {}

    /// @notice Takes an enum.
    function setStatus(Status status) external {}

    /// @notice Takes a contract/interface typed parameter.
    function setAdapter(IAdapter adapter) external {}
}
