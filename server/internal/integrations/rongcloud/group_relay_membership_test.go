package rongcloud

// 缺陷 D-012（2026-11-19）回归：群中继会话在启动时对成员列表做快照，
// 用户在中继进行中把某位 AI 移出群聊后，旧快照仍会给它派 your_turn
// （QA 实测「移出 opencode 后发『你好』，opencode 仍显示正在思考」）。
//
// 修复是 pump 派发前按镜像复核 groupMemberStillPresent。本文件钉住该
// 判定函数的三条分支：仍在群 → true；已移出 → false；镜像不可用/查询
// 失败 → true（fail-open，与 groupPaused 同一取向，抖动不哑群）。
// pump 内的完整派发链路由需要 discussion runtime 的重夹具覆盖，这里只
// 测判定函数 —— 它是修复唯一的判定点。

import (
	"context"
	"errors"
	"testing"
)

func aiMirror(members []GroupMember, err error) *GroupMirror {
	return &GroupMirror{
		ListAiMembers: func(context.Context, string) ([]GroupMember, error) {
			return members, err
		},
	}
}

func TestGroupMemberStillPresent(t *testing.T) {
	const (
		group = "g-1"
		kept  = "rc_node_machine1_opencode"
		gone  = "rc_node_machine2_opencode"
	)
	inGroup := []GroupMember{{UserID: kept}}

	cases := []struct {
		name   string
		mirror *GroupMirror
		rcID   string
		want   bool
	}{
		{"member still in group", aiMirror(inGroup, nil), kept, true},
		{"member removed from group", aiMirror(inGroup, nil), gone, false},
		{"mirror empty (all removed)", aiMirror(nil, nil), kept, false},
		{"mirror lookup fails fails open", aiMirror(nil, errors.New("db down")), kept, true},
		{"nil mirror fails open", nil, kept, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hub := &chatroomRelayHub{groupMirror: tc.mirror}
			if got := hub.groupMemberStillPresent(context.Background(), group, tc.rcID); got != tc.want {
				t.Errorf("groupMemberStillPresent(%s) = %v, want %v", tc.rcID, got, tc.want)
			}
		})
	}
}
