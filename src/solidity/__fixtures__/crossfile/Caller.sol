// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ITokenLike} from "./IToken.sol";
import {WrapLib} from "./WrapLib.sol";
import {Utils} from "./UtilsA.sol";

/// @dev Exercises cross-file resolution: an interface member call through `using ... for`
/// declared in a third file, and a duplicated library name disambiguated by the import graph.
contract Caller {
    ITokenLike public token;

    function doWrap(uint256 amount) external returns (uint256) {
        return WrapLib.wrapFor(token, amount);
    }

    function readTag(address marker) external {
        Utils.tag(marker);
    }
}
