// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ChainLib, IERC20Like} from "./ChainLib.sol";

contract ChainCaller {
    function run(IERC20Like token) external {
        ChainLib.hop1(token, msg.sender, address(this), 1);
    }
}
