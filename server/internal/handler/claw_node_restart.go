package handler

import (
	"log/slog"
	"net/http"
)

// ClawRestartNode POST /api/claw/nodes/{nodeId}/restart —— 用户态「重启这个智能体」。
//
// 为什么必须有这个接口
//
//	小程序运维会话里的「安全重启」一直只是一句话术（把「请先确认影响范围，再重启
//	异常服务并反馈结果。」填进输入框），执行者是跑在那台设备上的运维助手。设备一旦
//	离线、或者助手自己卡住，这句话就**没有执行者** —— 用户点完只能干等，等到最后
//	气泡只写「响应较慢，请稍候...」。
//
//	服务端其实早就有真正的重启能力（POST /api/claw/device/control/set，
//	action=restart：只重拉这一个 agent，不碰同机其他账号），但它校验的是**设备凭据**
//	（credentialId + secret）—— 那是设备自己或它的运维助手才有的东西，App 拿不到。
//	于是用户态一直是个洞，前端只能退回发自然语言。这条路由补的就是这个洞。
//
// 语义（三点，前端必须照着说）
//
//  1. **只重启一个 agent 子进程**：写 desired_version+1、状态仍是 running，supervisor
//     看到「状态没变、版本变了」就杀掉这一个子进程重拉。同机其他智能体不受影响。
//  2. **离线也写入**：这是排队，不是丢弃。设备上线（或看门狗把它拉起来）后第一轮
//     轮询就执行。响应里 online=false 时前端必须说「已排队」，不能说「已重启」。
//  3. **只有设备主人能调**：重启是破坏性动作（进行中的对话会被打断），判据用
//     claimed_by_user_id —— 好友边会把被分享者也算成「拥有者」，拿它做闸门等于把
//     别人设备的开关交出去（与 ClawUpdateNodePermission 同一条红线）。
//
// 一个诚实的边界
//
//	这套机制的前提是 supervisor 还活着 —— 由它读 control 行、杀子进程。整机离线时
//	没有任何远程通道能触达设备，只能靠设备端自启/崩溃看门狗把它拉回来；本接口能做的
//	只是「把意图先记下，等它回来第一件事就是执行」。
func (h *Handler) ClawRestartNode(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.clawRequireClawUser(w, r)
	if !ok {
		return
	}
	node, ok := h.clawLoadPermissionNode(w, r)
	if !ok {
		return
	}
	if !clawIsAgentOwner(node, userID) {
		clawJSON(w, 403, 403, "只有设备主人可以重启它", nil)
		return
	}
	if h.DB == nil {
		clawJSON(w, 503, 503, "数据库不可用", nil)
		return
	}

	// restart 的语义全在这个 true 上：状态仍是 running，但版本推进一格。
	version, err := h.clawDeviceSetNodeControl(
		r.Context(), node.ID, "running", "user:"+userID, true,
	)
	if err != nil {
		slog.Warn("claw: node restart write failed",
			"nodeId", node.NodeID, "user", userID, "error", err)
		clawJSON(w, 500, 500, "下发重启指令失败", nil)
		return
	}

	online := h.RongCloudNode != nil && h.RongCloudNode.IsOnline(node.ID)
	slog.Info("claw: node restart queued",
		"nodeId", node.NodeID, "user", userID, "online", online, "version", version)

	clawJSON(w, 200, 200, "", map[string]interface{}{
		"nodeId":          node.NodeID,
		"queued":          true,
		"online":          online,
		"desired_version": version,
	})
}
