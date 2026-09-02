// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ITokenLike {
    function wrap(uint256 amount) external returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}
