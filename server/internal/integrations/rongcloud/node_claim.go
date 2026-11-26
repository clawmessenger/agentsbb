package rongcloud

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// claimCacheTTL bounds how often the friend-list inversion is repeated. The
// admin device list is the only caller and it renders a page at a time, so a
// short window is enough to keep a single page load from re-fetching.
const claimCacheTTL = 15 * time.Second

// NodeClaimants maps an agent node's RongCloud user id to the claw/IM account
// that claims it.
//
// The mapping is derived from the RongCloud friend edges, because nothing local
// records IM ownership: rongcloud_node.owner_user_id points at the multica
// workspace manager (resolveWorkspaceAttribution picks the workspace's first
// manager), and rongcloud_pairing_session never captured the claiming account.
// The friend edge written when a device was claimed
// (BackfillAgentFriends with Bidirectional) is therefore the only 融云-side
// truth, and inverting it is what "按融云侧归属" means in practice.
//
// RongCloud friend relations are one-way and the platform API exposes no
// "who friended me" query, so inversion costs one /friend/get.json call per
// account. The whole map is memoised for claimCacheTTL.
//
// An account that fails to answer is skipped rather than failing the call: one
// bad token must not blank out the entire归属 column. The error is only
// returned when nothing at all could be resolved.
func (s *NodeService) NodeClaimants(ctx context.Context, imUserIDs []string) (map[string]string, error) {
	if s.client == nil {
		return nil, errors.New("rongcloud: API client not configured")
	}
	s.claimMu.Lock()
	if s.claimCache != nil && time.Since(s.claimCacheAt) < claimCacheTTL {
		cached := s.claimCache
		s.claimMu.Unlock()
		return cached, nil
	}
	s.claimMu.Unlock()

	claimants := make(map[string]string)
	var lastErr error
	answered := 0
	for _, userID := range imUserIDs {
		userID = strings.TrimSpace(userID)
		if userID == "" {
			continue
		}
		friends, err := s.client.FriendIDs(ctx, userID)
		if err != nil {
			lastErr = err
			continue
		}
		answered++
		for _, friend := range friends {
			// RongCloud friend edges are not unique across accounts in theory;
			// first writer wins so a page render stays deterministic.
			if _, taken := claimants[friend]; !taken {
				claimants[friend] = userID
			}
		}
	}
	if answered == 0 && lastErr != nil {
		return nil, lastErr
	}

	s.claimMu.Lock()
	s.claimCache = claimants
	s.claimCacheAt = time.Now()
	s.claimMu.Unlock()
	return claimants, nil
}

// NodeOwnedBy reports whether ownerRCUserID has the friend edge to the given
// node, i.e. whether the node shows up in that account's device list.
//
// This is the single-account form of the same 融云好友边 truth NodeClaimants
// inverts, and it is deliberately not built on top of it: NodeClaimants
// memoises a whole-account-set map in one shared cache slot, so calling it with
// a single user id would overwrite the admin device list's mapping with a
// one-account map for the next claimCacheTTL seconds. One /friend/get.json call
// is cheap enough for the per-request ownership check this backs.
//
// The claw user id doubles as its RongCloud account id (the login flow issues
// the rc token with user_id as the rc id), and binding writes the edge
// owner → node (bindAgentsToMachine), so "my friend list contains this rc id"
// is exactly "I bound this node" — the same rule the old web device list uses.
// An empty owner or node id is never an ownership, and a missing edge is a
// plain false, not an error: RongCloud simply doesn't have it.
func (s *NodeService) NodeOwnedBy(ctx context.Context, ownerRCUserID string, node db.RongcloudNode) (bool, error) {
	if s.client == nil {
		return false, errors.New("rongcloud: API client not configured")
	}
	owner := strings.TrimSpace(ownerRCUserID)
	target := strings.TrimSpace(node.RongcloudUserID)
	if owner == "" || target == "" {
		return false, nil
	}
	friends, err := s.client.FriendIDs(ctx, owner)
	if err != nil {
		return false, err
	}
	for _, friend := range friends {
		if strings.TrimSpace(friend) == target {
			return true, nil
		}
	}
	return false, nil
}

// InvalidateNodeClaimants drops the memoised friend-edge inversion. Claim
// changes must call this so the next read reflects the new edges instead of
// serving the pre-change mapping for up to claimCacheTTL.
func (s *NodeService) InvalidateNodeClaimants() {
	s.claimMu.Lock()
	s.claimCache = nil
	s.claimCacheAt = time.Time{}
	s.claimMu.Unlock()
}

// ---- claimed_by_user_id：好友边反查结果的本地投影（migrations/600） ----
//
// 归属的**真相**仍然是融云好友边；这一列只是把它缓存进库，让读路径（好友
// service 的 getDeviceOwner）从 O(N) 次 /friend/get.json 降到一次 SELECT。
//
// 为什么不用 sqlc：该列是 600 号迁移新加的，generated/ 目录本轮明确不做
// 全量 regen（工作区里有在途改动），所以这里直接走 DBTX 的参数化 SQL。

// ErrNodeClaimStoreUnavailable 表示调用方没有注入 DBTX（见 SetClaimDB），
// 投影列写不进去。所有调用点都把它当成 best-effort：归属的真相在好友边，
// 投影缺失只会让下一次读回退到反查（并顺带回填），不会答错。
var ErrNodeClaimStoreUnavailable = errors.New("rongcloud: node claim store not configured")

// claimEpoch 是投影列的写世代号：任何一次「改列」都会 +1，friendNodeOwners
// 用它判定自己手里那张 15s 反查 map 是否已经过期。
//
// 为什么需要它（而不是给读路径加 bypass）：归属的真值在融云好友边，15s map 是
// 它的记忆化副本，而写路径（绑定/转移/解绑/注销/主持解绑/手删好友）分散在
// NodeService 与 friend service 两处、**没有任何共享结构**。给写路径加一个
// 全局世代号，读路径只在「取缓存」时多比较一个整数，语义零变化；反过来给读
// 路径加 bypass 会改变「节点行不存在时还用不用缓存」这种边界语义，风险更大。
//
// 代价：任何一次认领写都会让所有实例的下一次读重建一次表（写很稀疏，可接受）。
var claimEpoch atomic.Uint64

// bumpClaimEpoch 必须在**列真的被改过之后**调用；失败路径不调用，避免无谓重建。
func bumpClaimEpoch() { claimEpoch.Add(1) }

// SetClaimDB injects the connection used by SetNodeClaim/ClearNodeClaim.
//
// Idempotent and safe to call on every request: the handler layer passes its
// own DBTX because the service is constructed in router.go with *db.Queries
// only, and that file is outside this change's scope. Once set it stays set.
func (s *NodeService) SetClaimDB(dbtx db.DBTX) {
	if s == nil || dbtx == nil {
		return
	}
	s.mu.Lock()
	s.claimDB = dbtx
	s.mu.Unlock()
}

func (s *NodeService) claimStore() db.DBTX {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.claimDB
}

// SetNodeClaim records ownerRCID as the claimant of nodeRCID in the local
// projection. Best-effort: the caller keeps going on error (the friend edge is
// the truth), which is why every failure is logged rather than returned to the
// user.
func (s *NodeService) SetNodeClaim(ctx context.Context, nodeRCID, ownerRCID string) error {
	dbtx := s.claimStore()
	if dbtx == nil {
		return ErrNodeClaimStoreUnavailable
	}
	nodeRCID = strings.TrimSpace(nodeRCID)
	ownerRCID = strings.TrimSpace(ownerRCID)
	if nodeRCID == "" || ownerRCID == "" {
		return nil
	}
	_, err := dbtx.Exec(ctx, `
		UPDATE rongcloud_node SET claimed_by_user_id = $1 WHERE rongcloud_user_id = $2`,
		ownerRCID, nodeRCID)
	if err != nil {
		s.log().Warn("rongcloud: record node claim failed",
			"node_rc", nodeRCID, "owner", ownerRCID, "error", err)
		return err
	}
	// 写路径 ①②：绑定 / 管理端转移。列变了，别的实例手里那张 map 立刻作废
	// （否则解绑/改归属后仍会在 15s 内答旧 owner）。
	bumpClaimEpoch()
	return nil
}

// ClearNodeClaim drops the local projection for nodeRCID. An empty ownerRCID
// clears it unconditionally; a non-empty one only clears a claim that actually
// belongs to that account, so deleting somebody else's friend edge cannot blank
// out the real owner's row.
func (s *NodeService) ClearNodeClaim(ctx context.Context, nodeRCID, ownerRCID string) error {
	dbtx := s.claimStore()
	if dbtx == nil {
		return ErrNodeClaimStoreUnavailable
	}
	nodeRCID = strings.TrimSpace(nodeRCID)
	if nodeRCID == "" {
		return nil
	}
	_, err := dbtx.Exec(ctx, `
		UPDATE rongcloud_node SET claimed_by_user_id = NULL
		WHERE rongcloud_user_id = $1 AND ($2 = '' OR claimed_by_user_id = $2)`,
		nodeRCID, strings.TrimSpace(ownerRCID))
	if err != nil {
		s.log().Warn("rongcloud: clear node claim failed",
			"node_rc", nodeRCID, "owner", ownerRCID, "error", err)
		return err
	}
	// 写路径 ③④（管理端删设备、C 端取消绑定/注销）：行虽然马上要被删掉，
	// 但 15s 反查 map 里还可能留着这台设备的旧 owner —— 必须让读路径立刻
	// 重建，否则「刚解绑，别人的设备还挂在我名下」还会被展示一整个 TTL。
	bumpClaimEpoch()
	return nil
}

func (s *NodeService) log() *slog.Logger {
	if s != nil && s.logger != nil {
		return s.logger
	}
	return slog.Default()
}

// GrantFriendship adds targetID to userID's RongCloud friend list, reporting
// whether the edge already existed. Mirrors the edge binding writes, so an
// ownership change leaves the node reachable in the new owner's contact list.
func (s *NodeService) GrantFriendship(ctx context.Context, userID, targetID, remark string) (bool, error) {
	if s.client == nil {
		return false, errors.New("rongcloud: API client not configured")
	}
	return s.client.addFriend(ctx, userID, targetID, remark)
}

// RevokeFriendship removes the given edges from userID's RongCloud friend list.
func (s *NodeService) RevokeFriendship(ctx context.Context, userID string, targetIDs ...string) error {
	if s.client == nil {
		return errors.New("rongcloud: API client not configured")
	}
	if len(targetIDs) == 0 {
		return nil
	}
	return s.client.RemoveFriends(ctx, userID, targetIDs...)
}

// friendEdgeNodeOwner lists the nodes a user owns, derived from the user's
// RongCloud friend edges — the same 融云好友边 truth NodeClaimants inverts.
// It is the P5 roundtable creation service's nodeOwner: for each friend rc
// account, GetRongCloudNodeByRongCloudUserID maps it back to its node row.
// A friend id with no node row (installation accounts, other claw users) is
// skipped; the per-machine infrastructure node never qualifies as a discussion
// participant (ai_type empty → no discussion capabilities), so it never enters
// the eligible set downstream.
func friendEdgeNodeOwner(queries *db.Queries, client *rongcloudAPIClient, logger *slog.Logger) func(ctx context.Context, userID string) ([]db.RongcloudNode, error) {
	return func(ctx context.Context, userID string) ([]db.RongcloudNode, error) {
		if queries == nil {
			return nil, errors.New("rongcloud: database not available")
		}
		if client == nil {
			return nil, errors.New("rongcloud: API client not configured")
		}
		friends, err := client.FriendIDs(ctx, userID)
		if err != nil {
			return nil, err
		}
		nodes := make([]db.RongcloudNode, 0, len(friends))
		for _, friend := range friends {
			friend = strings.TrimSpace(friend)
			if friend == "" {
				continue
			}
			node, err := queries.GetRongCloudNodeByRongCloudUserID(ctx, friend)
			if err != nil {
				// 好友里混着安装账号/真人 claw 用户：查不到节点行属正常，
				// 单个失败只跳过，不让整个归属列表失败。
				continue
			}
			nodes = append(nodes, node)
		}
		return nodes, nil
	}
}

// ---- 单拥有者换绑：绑定时把 agent 从旧拥有者迁到新拥有者 ----
//
// 用户口径：本机的 agent（如 opencode）只允许一个普通用户（设备拥有者）绑定。
// 当另一个账号绑定同一个 agent 时，程序自动把归属从旧拥有者迁到新账号：撤销
// 旧 owner → agent 的融云好友边（agent 从旧设备列表消失）、清掉归属投影，再
// 建新边并把投影写为新 owner。
//
// 这里**只迁移归属，不注销 agent 的融云账号**：agent 的 rc user / node / 凭据
// 全部保留复用，机器上的其他 agent 与账号不受影响。要物理注销账号是另一条
// 显式 opt-in 的路径（UnregisterNode / unregister=true），两者不可混用。
//
// 好友边与投影的读写都是 best-effort：任一步失败只记日志、不阻断绑定本身，
// 与既有绑定路径（bindAgentsToMachine）的口径一致。

// setNodeOwner 把节点归属设为 owner：先从当前拥有者（若有、且不是 owner）迁移
// 过来，再建 owner → node 好友边、写归属投影。供绑定路径调用；ops 节点与空
// owner 不进入这里（由调用方过滤）。
func (s *NodeService) setNodeOwner(ctx context.Context, nodeRCID, owner string) {
	nodeRCID = strings.TrimSpace(nodeRCID)
	owner = strings.TrimSpace(owner)
	if nodeRCID == "" || owner == "" {
		return
	}
	// 1) 迁移归属：撤销旧边 + 清投影（无旧 owner / 同一个 owner 时是 no-op）。
	oldOwner, moved := s.reassignNodeOwnerOnBind(ctx, nodeRCID, owner)
	// 2) 建新 owner → node 好友边（幂等：已是好友返回 25460 也算成功）。
	if s.client != nil {
		if _, err := s.client.addFriend(ctx, owner, nodeRCID, ""); err != nil {
			s.log().Warn("rongcloud: add friend for bound agent failed",
				"owner", owner, "node_rc", nodeRCID, "error", err)
		}
	}
	// 3) 写归属投影。好友边是真相，写失败只记日志，读路径会反查回填。
	if err := s.SetNodeClaim(ctx, nodeRCID, owner); err != nil &&
		!errors.Is(err, ErrNodeClaimStoreUnavailable) {
		s.log().Warn("rongcloud: sync node claim after bind failed",
			"owner", owner, "node_rc", nodeRCID, "error", err)
	}
	// 4) 真的换了主人时通知原账号：否则 agent 会从他设备列表里无声消失。
	// 放在归属写完之后，消息里的「现在归谁」才与库里的状态一致。
	if moved {
		s.notifyNodeRebound(ctx, nodeRCID, oldOwner, owner)
	}
}

// reassignNodeOwnerOnBind 维护「一个 agent 只有一个拥有者」：查出节点当前归属，
// 若属于另一个账号，就撤销该账号到节点的好友边并清掉归属投影，让 agent 从旧
// 拥有者的设备列表消失。返回被迁走的原拥有者（供换绑后通知）与是否真的发生了
// 迁移 —— 调用方只有拿到 moved=true 才需要发消息。
func (s *NodeService) reassignNodeOwnerOnBind(ctx context.Context, nodeRCID, newOwner string) (string, bool) {
	nodeRCID = strings.TrimSpace(nodeRCID)
	newOwner = strings.TrimSpace(newOwner)
	if nodeRCID == "" || newOwner == "" {
		return "", false
	}
	oldOwner := s.currentOwnerForReassign(ctx, nodeRCID)
	if oldOwner == "" || oldOwner == newOwner {
		return "", false
	}
	// 撤销旧 owner → agent 的单向好友边，与绑定写入的边界一致（owner → node）。
	if err := s.RevokeFriendship(ctx, oldOwner, nodeRCID); err != nil {
		s.log().Warn("rongcloud: revoke old owner edge on rebind failed",
			"node_rc", nodeRCID, "old_owner", oldOwner, "error", err)
	}
	// 只清属于旧 owner 的投影，避免清掉并发换绑刚写入的新归属。
	if err := s.ClearNodeClaim(ctx, nodeRCID, oldOwner); err != nil &&
		!errors.Is(err, ErrNodeClaimStoreUnavailable) {
		s.log().Warn("rongcloud: clear old owner claim on rebind failed",
			"node_rc", nodeRCID, "old_owner", oldOwner, "error", err)
	}
	s.log().Info("rongcloud: node ownership reassigned on bind",
		"node_rc", nodeRCID, "from", oldOwner, "to", newOwner)
	return oldOwner, true
}

// currentOwnerForReassign 读出节点当前归属账号。投影列命中即返回（绑定路径写过
// 它，是常态）；投影缺失时降级到好友边反查，与 getDeviceOwner 的读路径同源，
// 保证投影列尚未回填的存量 agent 也能正确换绑。
func (s *NodeService) currentOwnerForReassign(ctx context.Context, nodeRCID string) string {
	dbtx := s.claimStore()
	if dbtx == nil {
		return ""
	}
	owners := &friendNodeOwners{dbtx: dbtx, client: s.client, logger: s.log()}
	owner, found, err := owners.lookup(ctx, nodeRCID)
	if err != nil {
		s.log().Warn("rongcloud: lookup current owner on rebind failed",
			"node_rc", nodeRCID, "error", err)
		return ""
	}
	if !found {
		return ""
	}
	return owner
}
