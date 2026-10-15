// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice 最小の EIP-1271 ウォレット。
/// 署名の有効性は「いまの owner が署名したか」で決まる。
/// owner を替えれば、過去に出した署名はすべて無効になる。
contract RevocableWallet {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes4 internal constant INVALID = 0xffffffff;

    address public owner;

    event OwnerRotated(address indexed previous, address indexed next);

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        return _recover(hash, sig) == owner ? MAGIC : INVALID;
    }

    function rotateOwner(address next) external {
        require(msg.sender == owner, "not owner");
        emit OwnerRotated(owner, next);
        owner = next;
    }

    function _recover(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        return ecrecover(hash, v, r, s);
    }
}
