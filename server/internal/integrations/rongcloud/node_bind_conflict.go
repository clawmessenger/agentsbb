package rongcloud

import (
	"context"
	"fmt"
	"strings"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// AgentOwnerConflict 描述一个「已被其他账号绑定」的智能体节点。
//
// 用途：第二个账号在同一台机器上勾选这个 agent 时，服务端不再默默把归属
// 抢过来（旧行为），而是先把「现在归谁」交给前端问一句 —— 用户要么放弃、
// 继续用原账号，要么确认解绑并改绑到当前账号（force=true 才真换绑）。
type AgentOwnerConflict struct {
	Agent  string `json:"agent"`
	NodeID string `json:"nodeId"`
	// OwnerID 是当前拥有者（真人）的融云 id，也是 claw_im_users.user_id。
	OwnerID string `json:"ownerId"`
	// OwnerName 是给用户看的显示名（昵称优先），拿不到时退回 OwnerAccount。
	OwnerName string `json:"ownerName"`
	// OwnerAccount 是登录账号（虾说号），显示名缺失时用它兜底。
	OwnerAccount string `json:"ownerAccount"`
}

// AgentOwnedByOtherError 由 BindAgents 在未开 force 且目标 agent 已被别的
// 账号占用时返回。handler 据此回 409 + 冲突清单，让前端弹出确认框。
type AgentOwnedByOtherError struct {
	Conflicts []AgentOwnerConflict
}

func (e *AgentOwnedByOtherError) Error() string {
	if e == nil || len(e.Conflicts) == 0 {
		return "rongcloud: agent already bound to another account"
	}
	agents := make([]string, 0, len(e.Conflicts))
	for _, c := range e.Conflicts {
		agents = append(agents, c.Agent)
	}
	return fmt.Sprintf("rongcloud: agent already bound to another account: %s", strings.Join(agents, ", "))
}

// agentNodeOwner 是「agent → 已有节点 → 当前拥有者」的三元组，
// 供纯函数 bindOwnerConflicts 判定冲突（不含任何 IO，单测直接构造）。
type agentNodeOwner struct {
	Agent   string
	NodeID  string
	OwnerID string
}

// bindOwnerConflicts 挑出属于别人的项。
//
// 判据只有一条：节点当前拥有者非空且不等于发起方。ownerRCID 为空表示调用方
// 没有「人类归属」概念（设备凭据自动绑内置运维 agent），这种路径不做拦截。
// 同一账号重复绑定、节点尚无归属（首次绑定）都不算冲突，保持幂等。
func bindOwnerConflicts(rows []agentNodeOwner, ownerRCID string) []AgentOwnerConflict {
	ownerRCID = strings.TrimSpace(ownerRCID)
	if ownerRCID == "" {
		return nil
	}
	var conflicts []AgentOwnerConflict
	for _, row := range rows {
		owner := strings.TrimSpace(row.OwnerID)
		if owner == "" || owner == ownerRCID {
			continue
		}
		conflicts = append(conflicts, AgentOwnerConflict{
			Agent:   row.Agent,
			NodeID:  row.NodeID,
			OwnerID: owner,
		})
	}
	return conflicts
}

// pendingBindConflicts 在真正建节点/换绑之前，把「已属于其他账号」的 agent
// 找出来。要按 machine+agent 先查已有节点：ensureAgentNode 是幂等复用，
// 若先建后判，冲突信息（原拥有者）就已经被换绑逻辑清掉了。
func (s *NodeService) pendingBindConflicts(ctx context.Context, machineNode db.RongcloudNode, machineID string, agents []string, ownerRCID string) ([]AgentOwnerConflict, error) {
	if strings.TrimSpace(ownerRCID) == "" {
		return nil, nil
	}
	rows := make([]agentNodeOwner, 0, len(agents))
	seen := make(map[string]bool, len(agents))
	for _, agent := range agents {
		agent = strings.TrimSpace(agent)
		if agent == "" || seen[agent] {
			continue
		}
		seen[agent] = true
		node, found, err := s.findMachineAgentNode(ctx, machineNode.WorkspaceID, machineID, agent)
		if err != nil {
			return nil, err
		}
		if !found {
			continue
		}
		// 先读本地投影列（节点行本来就在手上，零成本），空再降级到好友边反查
		// —— 与 friendNodeOwners.lookup 的读序一致。只靠 claimStore 那条路会
		// 在没挂连接池的调用方（按码绑定曾经就是）静默失明，导致「有主」被
		// 当成「无主」，第二个账号直接抢走。
		owner := ""
		if node.ClaimedByUserID.Valid {
			owner = strings.TrimSpace(node.ClaimedByUserID.String)
		}
		if owner == "" {
			owner = s.currentOwnerForReassign(ctx, node.RongcloudUserID)
		}
		if owner == "" {
			continue
		}
		rows = append(rows, agentNodeOwner{Agent: agent, NodeID: node.NodeID, OwnerID: owner})
	}
	conflicts := bindOwnerConflicts(rows, ownerRCID)
	for i := range conflicts {
		conflicts[i].OwnerName, conflicts[i].OwnerAccount = s.ownerDisplay(ctx, conflicts[i].OwnerID)
	}
	return conflicts, nil
}

// ownerDisplay 把拥有者融云 id 解析成「昵称 + 登录账号」。
//
// 两级兜底：claw_im_users（C 端真人，user_id 即融云 id）→ rongcloud_user
// 镜像表（其余账号）。都查不到就把 id 自己当显示名 —— 提示语宁可难看，
// 也不能空着让用户不知道在跟谁抢设备。
func (s *NodeService) ownerDisplay(ctx context.Context, ownerRCID string) (name, account string) {
	ownerRCID = strings.TrimSpace(ownerRCID)
	if ownerRCID == "" {
		return "", ""
	}
	if s.queries != nil {
		if u, err := s.queries.GetClawIMUserByUserID(ctx, ownerRCID); err == nil {
			account = strings.TrimSpace(u.Username)
			if u.Nickname.Valid {
				name = strings.TrimSpace(u.Nickname.String)
			}
		}
	}
	if name == "" {
		if u, err := s.GetUserByRongCloudID(ctx, ownerRCID); err == nil {
			name = strings.TrimSpace(u.Name.String)
		}
	}
	if name == "" && account == "" {
		name = ownerRCID
	}
	return name, account
}
