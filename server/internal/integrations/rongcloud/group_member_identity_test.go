package rongcloud

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

// canonicalizeMemberIDs 的纯逻辑：D-002 的折叠语义与安全底线。
func TestCanonicalizeMemberIDs(t *testing.T) {
	cases := []struct {
		name     string
		ids      []string
		resolved map[string]string
		want     []string
	}{
		{
			name:     "未装配归一（空 map）时原样返回",
			ids:      []string{"zhangsan", "rc_node_abc", "user-8"},
			resolved: nil,
			want:     []string{"zhangsan", "rc_node_abc", "user-8"},
		},
		{
			name: "同一账号的 username 与 phone 都归一到同一个融云 id",
			ids:  []string{"zhangsan", "13800000000", "rc-1001"},
			resolved: map[string]string{
				"zhangsan":    "rc-1001",
				"13800000000": "rc-1001",
			},
			want: []string{"rc-1001", "rc-1001", "rc-1001"},
		},
		{
			name: "查不到的 AI 节点 / 运维账号一律原样保留，绝不丢弃",
			ids:  []string{"zhangsan", "rc_node_abc", "claw_42", "pi_3300776275", "rc-ops-1"},
			resolved: map[string]string{
				"zhangsan": "rc-1001",
			},
			want: []string{"rc-1001", "rc_node_abc", "claw_42", "pi_3300776275", "rc-ops-1"},
		},
		{
			name: "空 canonical 不写成空成员",
			ids:  []string{"zhangsan", "user-8"},
			resolved: map[string]string{
				"zhangsan": "",
			},
			want: []string{"zhangsan", "user-8"},
		},
		{
			name:     "空列表",
			ids:      nil,
			resolved: map[string]string{"x": "y"},
			want:     nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := canonicalizeMemberIDs(tc.ids, tc.resolved)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("canonicalizeMemberIDs() = %v, want %v", got, tc.want)
			}
		})
	}
}

// 集成证明：归一回调真的接进了 handleGroupCreate，且能把「owner 被以
// username 重复注入」折叠掉 —— 这就是 QA D-002「选 1 人却多出绑定手机号
// 的账号」的服务端闭环。
func TestGroupCreateResolvesMemberIdentities(t *testing.T) {
	rec, srv := newGroupTestServer(t)
	defer srv.Close()
	stub := newGroupMirrorStub()
	mirror := stub.mirror()

	var resolvedCalledWith []string
	mirror.ResolveMemberIDs = func(_ context.Context, ids []string) (map[string]string, error) {
		resolvedCalledWith = append([]string(nil), ids...)
		// 「zhangsan」与「13800000000」都是群主 user-7 的其它身份标识；
		// rc_node_abc 是 AI 节点，查不到，不应出现在 map 里。
		return map[string]string{
			"zhangsan":    "user-7",
			"13800000000": "user-7",
		}, nil
	}
	handler := newGroupCommandHandler(t, rec, srv, mirror)

	msg := NormalizedMessage{
		ObjectName: objectNameCommand,
		FromUserID: "user-7",
		Content: `{"request_id":"r1","service":"group","action":"create","params":{
			"groupName":"产品讨论","ownerId":"zhangsan",
			"memberIds":["zhangsan","13800000000","rc_node_abc","user-8"]}}`,
	}
	if err := handler.handleCommand(context.Background(), msg); err != nil {
		t.Fatalf("handleCommand: %v", err)
	}

	if !reflect.DeepEqual(resolvedCalledWith, []string{"zhangsan", "13800000000", "rc_node_abc", "user-8"}) {
		t.Errorf("resolver called with %v", resolvedCalledWith)
	}
	creates := rec.calls("/group/create.json")
	if len(creates) != 1 {
		t.Fatalf("create calls = %d, want 1", len(creates))
	}
	// owner 只出现一次；AI 节点 rc_node_abc 仍在；user-8 保留。
	if got := creates[0]["userId"]; got != "user-7,rc_node_abc,user-8" {
		t.Errorf("userId = %q, want owner once + preserved AI node + other member", got)
	}
	if len(stub.saved) != 1 {
		t.Fatalf("saved groups = %d, want 1", len(stub.saved))
	}
	if got := len(stub.saved[0].MemberIDs); got != 3 {
		t.Errorf("mirrored members = %d, want 3", got)
	}
}

// fail-open：归一查询故障不应阻断建群，退回既有字符串去重行为。
func TestGroupCreateKeepsGoingWhenMemberResolutionFails(t *testing.T) {
	rec, srv := newGroupTestServer(t)
	defer srv.Close()
	stub := newGroupMirrorStub()
	mirror := stub.mirror()
	mirror.ResolveMemberIDs = func(_ context.Context, _ []string) (map[string]string, error) {
		return nil, errors.New("db is down")
	}
	handler := newGroupCommandHandler(t, rec, srv, mirror)

	msg := NormalizedMessage{
		ObjectName: objectNameCommand,
		FromUserID: "user-7",
		Content: `{"request_id":"r1","service":"group","action":"create","params":{
			"groupName":"产品讨论","memberIds":["user-8"]}}`,
	}
	if err := handler.handleCommand(context.Background(), msg); err != nil {
		t.Fatalf("handleCommand: %v", err)
	}
	creates := rec.calls("/group/create.json")
	if len(creates) != 1 {
		t.Fatalf("create calls = %d, want 1 (resolution failure must not block create)", len(creates))
	}
	if got := creates[0]["userId"]; got != "user-7,user-8" {
		t.Errorf("userId = %q, want legacy dedupe result", got)
	}
}
