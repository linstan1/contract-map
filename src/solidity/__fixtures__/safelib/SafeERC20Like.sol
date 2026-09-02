// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20Like} from "./IERC20Like.sol";

/// @dev A SafeERC20-shaped library called with the explicit `Lib.fn(receiver, ...)` form.
library SafeERC20Like {
    function safeTransferFrom(IERC20Like token, address from, address to, uint256 amount) internal {
        token.transferFrom(from, to, amount);
    }
}
