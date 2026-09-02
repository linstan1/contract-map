// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ITokenLike} from "./IToken.sol";

/// @dev A library called both explicitly and via `using ... for` from another file.
library WrapLib {
    function wrapFor(ITokenLike token, uint256 amount) internal returns (uint256) {
        return token.wrap(amount);
    }
}
