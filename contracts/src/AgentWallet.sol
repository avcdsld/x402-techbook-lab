// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IDomain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @notice エージェントに「セッション鍵」だけを渡す EIP-1271 ウォレット。
///
/// isValidSignature は 32 バイトのハッシュしか受け取らない。
/// そこで署名バイト列に EIP-3009 の認可内容そのものを同梱させ、
/// ウォレット側でハッシュを再計算して一致を確かめてから、中身を検査する。
///
/// isValidSignature は view（トークンからは staticcall）なので、ここでは状態を書けない。
/// 累積の支出額は数えられない。累積の上限は「残高」そのもので与える。
contract AgentWallet {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes4 internal constant INVALID = 0xffffffff;
    bytes32 internal constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    struct Authorization {
        address from;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
    }

    address public immutable owner; // 人間
    address public immutable token;
    address public sessionKey; // エージェント
    uint256 public maxPerPayment;
    uint256 public maxWindow; // 署名の有効期間の上限（秒）
    mapping(address => bool) public allowedPayee;

    constructor(address owner_, address token_) {
        owner = owner_;
        token = token_;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function setSession(address key, uint256 perPayment, uint256 window) external onlyOwner {
        sessionKey = key;
        maxPerPayment = perPayment;
        maxWindow = window;
    }

    function setPayee(address payee, bool allowed) external onlyOwner {
        allowedPayee[payee] = allowed;
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        // 人間の鍵：何でも署名できる
        if (sig.length == 65) return _recover(hash, sig) == owner ? MAGIC : INVALID;

        // セッション鍵：認可の中身を検査する
        (Authorization memory a, bytes memory inner) = abi.decode(sig, (Authorization, bytes));
        if (_digest(a) != hash) return INVALID; // 同梱された中身が、署名対象と一致するか
        if (a.from != address(this)) return INVALID;
        if (!allowedPayee[a.to]) return INVALID;
        if (a.value > maxPerPayment) return INVALID;
        if (a.validBefore > block.timestamp + maxWindow) return INVALID;
        if (sessionKey == address(0) || _recoverMem(hash, inner) != sessionKey) return INVALID;
        return MAGIC;
    }

    function _digest(Authorization memory a) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce)
        );
        return keccak256(abi.encodePacked("\x19\x01", IDomain(token).DOMAIN_SEPARATOR(), structHash));
    }

    function _recover(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        return ecrecover(hash, uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64]));
    }

    function _recoverMem(bytes32 hash, bytes memory sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        return ecrecover(hash, v, r, s);
    }
}

/// @notice 対照実験用：isValidSignature の中で支出額を記録しようとするウォレット。
/// トークンは staticcall で呼ぶので、状態の書き込みは失敗する。
contract CountingWallet {
    address public immutable owner;
    uint256 public spentCount;

    constructor(address owner_) {
        owner = owner_;
    }

    // view を付けない（付けるとコンパイルが通らないため）
    function isValidSignature(bytes32 hash, bytes calldata sig) external returns (bytes4) {
        spentCount += 1; // ← ここで書き込みたい
        address signer = ecrecover(hash, uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64]));
        return signer == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
