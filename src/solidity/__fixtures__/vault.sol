// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
pragma abicoder v2;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface ILendingPool {
    function supply(address asset, uint256 amount) external;
    function withdraw(address asset, uint256 amount) external returns (uint256);
}

/// @dev A minimal SafeERC20-style wrapper, called both explicitly and via `using ... for`.
library SafeERC20 {
    function safeTransferFrom(IERC20 token, address from, address to, uint256 amount) internal {
        bool ok = token.transferFrom(from, to, amount);
        require(ok, "transferFrom failed");
    }
}

/// @notice An ERC4626-style vault. `deposit` pulls the asset through a library-wrapped
/// `transferFrom` and then supplies it to a lending pool through an interface-typed state variable.
contract SimpleVault {
    using SafeERC20 for IERC20;

    IERC20 public immutable asset;
    ILendingPool public pool;
    mapping(address => uint256) public shares;
    uint256 public totalShares;

    constructor(address _asset, address _pool) {
        asset = IERC20(_asset);
        pool = ILendingPool(_pool);
    }

    /// @notice Deposits `amount` of the underlying asset and mints shares 1:1.
    function deposit(uint256 amount) external returns (uint256) {
        asset.safeTransferFrom(msg.sender, address(this), amount);
        pool.supply(address(asset), amount);
        shares[msg.sender] += amount;
        totalShares += amount;
        return amount;
    }

    function withdraw(uint256 amount) external returns (uint256) {
        shares[msg.sender] -= amount;
        totalShares -= amount;
        uint256 got = pool.withdraw(address(asset), amount);
        return got;
    }

    function assetBalance() external view returns (uint256) {
        return IERC20(asset).balanceOf(address(this));
    }
}
