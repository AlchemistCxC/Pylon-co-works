/**
 * gitContracts — Git 只读 DTO 收窄（W2-02）。
 *
 * git_status / git_history（§5.8）宽容 normalize：porcelain 码原样保留（M/A/??/R），
 * date 是 Unix 秒（前端自格式化）；损坏 DTO 跳过不崩；非 git 仓库错误（git_error）分类。
 */
export interface GitStatusEntry {
    path: string;
    status: string;
    staged: boolean;
}
export interface GitCommit {
    hash: string;
    author: string;
    date: number;
    subject: string;
}
/** ISSUE-15 W4：git_status_with_branch 的分支信息（后端 porcelain v2 --branch header）。 */
export interface GitBranchInfo {
    branch: string | null;
    detached: boolean;
    head: string | null;
}
/** ISSUE-15 W4：git_status_with_branch 完整响应（branch + entries）。 */
export interface GitStatusWithBranch {
    branch: GitBranchInfo;
    entries: unknown[];
}
/** 受限 Git 写操作的统一回执。 */
export interface GitOperationResult {
    summary: string;
    status: GitStatusWithBranch;
}
/** ISSUE-15 W4：宽容 normalize——entries 走 normalizeGitStatus；branch 三态派生（真实名/detached/占位）。 */
export declare function normalizeGitStatusWithBranch(raw: unknown): GitStatusWithBranch;
export declare function normalizeGitOperationResult(raw: unknown): GitOperationResult;
export declare function normalizeGitStatus(raw: unknown): GitStatusEntry[];
export declare function normalizeGitHistory(raw: unknown): GitCommit[];
/** git_error 分类（§4：非 git 仓库/不可用/失败/超时） */
export interface GitErrorDetail {
    kind: 'not-repo' | 'unavailable' | 'failed' | 'timeout' | 'unknown';
    message: string;
}
export declare function classifyGitError(error: unknown): GitErrorDetail;
