// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Like {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @dev A library whose external call sits three internal hops deep, all inside this one library.
library ChainLib {
    function hop1(IERC20Like token, address from, address to, uint256 amount) internal {
        hop2(token, from, to, amount);
    }

    function hop2(IERC20Like token, address from, address to, uint256 amount) private {
        hop3(token, from, to, amount);
    }

    function hop3(IERC20Like token, address from, address to, uint256 amount) private {
        token.transferFrom(from, to, amount);
    }
}
