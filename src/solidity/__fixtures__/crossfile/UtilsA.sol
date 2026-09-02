// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev A marker interface distinct from the one in UtilsB.sol, so a resolved call site is provable.
interface IMarker {
    function markA() external;
}

/// @dev First of two libraries sharing the name `Utils`, in separate files.
library Utils {
    function tag(address marker) internal {
        IMarker(marker).markA();
    }
}
