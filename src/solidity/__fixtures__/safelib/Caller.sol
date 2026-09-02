// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20Like} from "./IERC20Like.sol";
import {SafeERC20Like} from "./SafeERC20Like.sol";

/// @dev Calls the library with the explicit `Lib.fn(receiver, ...)` form: the receiver is the
/// caller's own `tokenArg` parameter, substituted through the library's own `token` parameter.
contract SafeCaller {
    function run(IERC20Like tokenArg) external {
        SafeERC20Like.safeTransferFrom(tokenArg, msg.sender, address(this), 100);
    }
}
