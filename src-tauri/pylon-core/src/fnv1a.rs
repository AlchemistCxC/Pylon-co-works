//! FNV-1a 64 位哈希唯一实现（L8 收编：域内四份手写循环归一，逐位保值）。
//!
//! 用途是身份/指纹（candidateId、catalog revision、搜索/配置指纹），不是安全边界。
//! `fnv1a-{hash:016x}` 输出格式与哈希值都进入 wire 契约，逐字稳定；本模块只收编
//! 实现位置，算法、常量与输出格式与原四份手写循环（`agent_detection` 的
//! `stable_candidate_id` / `search_roots_fingerprint`、`agent_catalog::catalog_revision`、
//! 宿主 `agent/detection.rs::configured_fingerprint`）逐位一致。

/// FNV-1a 64 位偏移基数（offset basis）。
pub const FNV_OFFSET_BASIS: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

/// 从给定中间态继续对字节流做 FNV-1a 折叠（xor → mul prime）。
///
/// 供多字段流式哈希复用同一实现（如长度前缀拼接的 candidateId）；单段输入直接用
/// [`fnv1a_64`]。
pub fn fold64(mut hash: u64, bytes: &[u8]) -> u64 {
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// 对整段输入做 FNV-1a 64 位折叠，返回 64 位摘要。
pub fn fnv1a_64(bytes: &[u8]) -> u64 {
    fold64(FNV_OFFSET_BASIS, bytes)
}

/// [`fnv1a_64`] 的既有 wire 输出形状：`fnv1a-{hash:016x}`（前缀与十六进制逐字契约）。
pub fn fnv1a_64_prefixed(bytes: &[u8]) -> String {
    format!("fnv1a-{:016x}", fnv1a_64(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 标准测试向量（FNV-1a 64，LH/IST 公开向量）+ 空输入 = 裸基数。
    #[test]
    fn matches_standard_fnv1a_64_vectors() {
        assert_eq!(fnv1a_64(b""), 0xcbf29ce484222325);
        assert_eq!(fnv1a_64(b"a"), 0xaf63dc4c8601ec8c);
        assert_eq!(fnv1a_64(b"foobar"), 0x85944171f73967e8);
    }

    /// 输出形状是 wire 契约：`fnv1a-` 前缀 + 16 位小写十六进制，逐字断言。
    #[test]
    fn prefixed_output_keeps_the_wire_format_verbatim() {
        assert_eq!(fnv1a_64_prefixed(b""), "fnv1a-cbf29ce484222325");
        assert_eq!(fnv1a_64_prefixed(b"foobar"), "fnv1a-85944171f73967e8");
    }

    /// 流式折叠与整段折叠逐位一致（长度前缀拼接场景的正确性前提）。
    #[test]
    fn streamed_folding_matches_whole_input() {
        let whole = fnv1a_64(b"length-prefixed-field-stream");
        let streamed = fold64(
            fold64(fold64(FNV_OFFSET_BASIS, b"length-"), b"prefixed-"),
            b"field-stream",
        );
        assert_eq!(whole, streamed);
    }
}
