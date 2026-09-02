// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev A marker interface distinct from the one in UtilsA.sol, so a resolved call site is provable.
interface IMarker {
    function markB() external;
}

/// @dev Second of two libraries sharing the name `Utils`, in separate files. `Caller.sol` never
/// imports this one, so a call site must not resolve here.
library Utils {
    function tag(address marker) internal {
        IMarker(marker).markB();
    }
}
